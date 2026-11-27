import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { atomicJSON, readJSON, scopeKey } from './agentic-client.js';

export const createPollTool = {
  type: 'function', name: 'create_poll', strict: true,
  description: 'Create a Slack poll with clickable voting buttons in the current request thread. Use only when the requester asks to create a poll, not when merely discussing one. Supply a question and 2–10 distinct choices. Each person has one vote and can change it; totals are visible. The requester or an app admin can close voting. The app posts the poll immediately; do not duplicate it with a text poll. No external polling service is needed.',
  parameters: { type: 'object', additionalProperties: false, required: ['question', 'options'], properties: {
    question: { type: 'string', minLength: 1, maxLength: 300 },
    options: { type: 'array', minItems: 2, maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 100 } },
  } },
};

export const saveChannelDocumentTool = {
  type: 'function', name: 'save_channel_document', strict: true,
  description: 'When the requester asks to document/save information in this channel’s bookmarks, write a UTF-8 Markdown (.md) file, upload it into the current thread, and add a channel bookmark linking to that Slack file. Supply the complete document content, a short descriptive title, and a simple .md filename. Use conversation evidence; do not invent decisions. This creates a new document, not an edit of an existing one. The app performs the upload and bookmark immediately. Only claim bookmarking if bookmarked=true; on partial failure link to the uploaded file and explain the error. Do not also emit a slack_file tag. Cannot target other channels or run in DMs.',
  parameters: { type: 'object', additionalProperties: false, required: ['title', 'filename', 'content'], properties: {
    title: { type: 'string', minLength: 1, maxLength: 100 },
    filename: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\\.md$' },
    // Long bounded strings are expensive in older XGrammar structured decoding.
    // validateArgs enforces nonempty content, 200 KB, and the configured file cap.
    content: { type: 'string', description: 'Complete Markdown document, including a heading and useful context; at most 200 KB. Write the document directly in this argument instead of drafting it in a separate chat answer first. After success, return a brief confirmation and the file link; do not repeat the document.' },
  } },
};

const plain = text => ({ type: 'plain_text', text, emoji: true });
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const button = (text, action_id, value) => ({ type: 'button', text: plain(text), action_id, value });

export function pollMessage(poll) {
  const counts = poll.options.map((_, i) => Object.values(poll.votes).filter(vote => vote === i).length);
  const total = Object.keys(poll.votes).length;
  const status = `${poll.closed ? 'Closed' : 'One vote per person · Click another option to change your vote'} · ${total} vote${total === 1 ? '' : 's'}`;
  const lines = poll.options.map((option, i) => `${i + 1}. ${option} — ${counts[i]}`);
  const blocks = [
    { type: 'section', text: plain(`Poll: ${poll.question}`) },
    ...lines.map((text, i) => ({ type: 'section', text: plain(text),
      ...(!poll.closed ? { accessory: button(`Vote ${i + 1}`, 'poll_vote', `${poll.id}:${i}`) } : {}) })),
    { type: 'context', elements: [plain(status)] },
    ...(!poll.closed ? [{ type: 'actions', elements: [button('Close poll', 'poll_close', poll.id)] }] : []),
  ].map((block, i) => ({ ...block, block_id: `poll_${poll.id}_${poll.revision}_${i}` }));
  return { text: escape(`Poll: ${poll.question}\n${lines.join('\n')}\n${status}`), blocks, parse: 'none' };
}

function requireOK(result) {
  if (result?.ok !== true) throw Object.assign(new Error('Slack rejected the operation.'), { data: result });
  return result;
}

export function slackToolError(error) {
  const code = error?.data?.error;
  if (code === 'missing_scope') return 'Slack permission missing. An admin must add bookmarks:write, files:write and files:read as needed, then reinstall the app.';
  if (code === 'too_many_bookmarks') return 'This channel has reached Slack’s bookmark limit. Remove an unused bookmark and try again.';
  if (['not_in_channel', 'channel_not_found'].includes(code)) return 'Invite the app to this channel and try again.';
  if (['not_allowed', 'restricted_action', 'permission_denied'].includes(code)) return 'Slack does not allow the app to perform this action in this channel.';
  return 'Slack could not confirm the operation. Check this thread and channel bookmarks before requesting it again.';
}

function validateArgs(name, args, maxBytes) {
  const keys = name === 'create_poll' ? ['question', 'options'] : ['title', 'filename', 'content'];
  if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).some(k => !keys.includes(k))) throw new Error('Use only the fields in the tool schema.');
  if (name === 'create_poll') {
    if (typeof args.question !== 'string' || !args.question.trim() || args.question.length > 300) throw new Error('Provide a question of 1–300 characters.');
    if (!Array.isArray(args.options) || args.options.length < 2 || args.options.length > 10 || args.options.some(o => typeof o !== 'string' || !o.trim() || o.length > 100)) throw new Error('Provide 2–10 choices, each 1–100 characters.');
    const options = args.options.map(o => o.trim());
    if (new Set(options.map(o => o.toLowerCase())).size !== options.length) throw new Error('Poll choices must be distinct.');
    return { question: args.question.trim(), options };
  }
  if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 100) throw new Error('Provide a title of 1–100 characters.');
  if (typeof args.filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.md$/.test(args.filename)) throw new Error('Use a simple filename ending in .md, without directories.');
  if (typeof args.content !== 'string' || !args.content.trim() || args.content.includes('\0') || args.content.length > 200000 || Buffer.byteLength(args.content) > Math.min(200000, maxBytes)) throw new Error('Provide nonempty Markdown within the file size limit (at most 200 KB).');
  return { title: args.title.trim(), filename: args.filename, content: args.content };
}

// One bridge process per installation. Serialize creates and button updates so
// simultaneous users/subagents cannot lose votes or repeat a Slack write.
export class SlackTools {
  constructor(dir) { this.dir = dir; this.locks = new Map(); }
  file(id) {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid action ID.');
    return path.join(this.dir, `${id}.json`);
  }
  async locked(id, fn) {
    const previous = this.locks.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    this.locks.set(id, current);
    try { return await current; } finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }
  handlers({ client, job, authorize, canSaveDocuments, scrub = x => x, maxBytes = 200000 }) {
    const run = name => async (raw, { signal } = {}) => {
      let args;
      try { args = validateArgs(name, JSON.parse(scrub(raw)), maxBytes); }
      catch (error) { return { ok: false, error: error instanceof SyntaxError ? 'Tool arguments must be valid JSON.' : error.message }; }
      const id = scopeKey([name, job.channel, job.threadTs, job.user, job.requestTs, args]);
      return this.locked(id, async () => {
        signal?.throwIfAborted();
        if (job.cancelled || !/^[CG]/.test(job.channel) || !(await authorize(name))) return { ok: false, error: 'Your current permissions do not allow this Slack action here.' };
        const file = this.file(id);
        const saved = readJSON(file);
        if (saved) {
          job.slackActionsAttempted = true;
          return saved.result || { ok: false, error: 'An earlier attempt may already have posted. Check the thread before creating another.' };
        }
        job.slackActionIds ||= new Set();
        if (job.slackActionIds.size >= 4) return { ok: false, error: 'At most four poll/document actions are allowed per request.' };
        job.slackActionIds.add(id);
        signal?.throwIfAborted();
        const record = { id, kind: name, channel: job.channel, threadTs: job.threadTs, owner: job.user, createdAt: new Date().toISOString(), status: 'pending' };
        atomicJSON(file, record); // An uncertain network result must never trigger an automatic duplicate.
        job.slackActionsAttempted = true;
        job.phase = name === 'create_poll' ? 'Creating the poll' : 'Saving the channel document';
        try {
          if (name === 'create_poll') {
            Object.assign(record, args, { votes: {}, closed: false, revision: 0 });
            const posted = requireOK(await client.chat.postMessage({ channel: job.channel, thread_ts: job.threadTs, ...pollMessage(record), unfurl_links: false, unfurl_media: false }));
            if (!posted.ts) throw new Error('Missing poll timestamp.');
            Object.assign(record, { ts: posted.ts, status: 'ready', result: { ok: true, poll_id: id, message_ts: posted.ts, delivery: 'The interactive poll is already posted in this thread. People can vote using its buttons.' } });
          } else {
            const docDir = path.join(this.dir, 'documents', id);
            mkdirSync(docDir, { recursive: true, mode: 0o700 });
            writeFileSync(path.join(docDir, args.filename), args.content, { mode: 0o600 });
            const uploaded = requireOK(await client.files.uploadV2({ channel_id: job.channel, thread_ts: job.threadTs,
              file: Buffer.from(args.content, 'utf8'), filename: args.filename, title: args.title }));
            // @slack/web-api uploadV2 wraps completeUploadExternal responses.
            const files = (uploaded.files || []).flatMap(item => item.files ? requireOK(item).files : [item]);
            const uploadedFile = files.find(item => item?.id);
            if (!uploadedFile) throw new Error('Missing uploaded file ID.');
            record.fileId = uploadedFile.id;
            record.result = { ok: false, uploaded: true, bookmarked: false, file_id: uploadedFile.id, filename: args.filename };
            atomicJSON(file, record);
            const info = uploadedFile.permalink ? uploadedFile : requireOK(await client.files.info({ file: uploadedFile.id })).file;
            const link = new URL(info?.permalink);
            if (link.protocol !== 'https:' || !(link.hostname === 'slack.com' || link.hostname.endsWith('.slack.com')) || link.username || link.password) throw new Error('Invalid file permalink.');
            record.result.url = link.href;
            atomicJSON(file, record);
            signal?.throwIfAborted();
            if (job.cancelled || !(await authorize(name))) throw new Error('Authorization changed before bookmarking.');
            const added = requireOK(await client.bookmarks.add({ channel_id: job.channel, title: args.title, type: 'link', link: link.href }));
            record.status = 'ready';
            record.result = { ...record.result, ok: true, bookmarked: true, bookmark_id: added.bookmark?.id, delivery: 'The Markdown file is uploaded in this thread and linked from this channel’s bookmarks.' };
          }
        } catch (error) {
          record.status = 'failed';
          record.result = { ...record.result, ok: false, error: record.fileId && (signal?.aborted || job.cancelled) ? 'The file was uploaded, but bookmarking was stopped.' : slackToolError(error) };
        }
        atomicJSON(file, record);
        return record.result;
      });
    };
    return { create_poll: run('create_poll'), ...(canSaveDocuments ? { save_channel_document: run('save_channel_document') } : {}) };
  }

  async interact({ client, id, channel, messageTs, user, option, close = false, authorize }) {
    return this.locked(id, async () => {
      const file = this.file(id);
      const poll = readJSON(file);
      if (!poll || poll.kind !== 'create_poll' || poll.status !== 'ready' || poll.channel !== channel || poll.ts !== messageTs) return { ok: false, message: 'That poll is unavailable or does not match this message.' };
      const access = await authorize();
      if (!access.allowed) return { ok: false, threadTs: poll.threadTs, message: 'Your current access does not allow voting or managing this poll.' };
      if (close && user !== poll.owner && !access.admin) return { ok: false, threadTs: poll.threadTs, message: 'Only the poll creator or an app admin can close it.' };
      if (!close && poll.closed) return { ok: false, threadTs: poll.threadTs, message: 'This poll is closed.' };
      if (close) poll.closed = true;
      else {
        if (!Number.isInteger(option) || option < 0 || option >= poll.options.length || !/^[UW][A-Z0-9]+$/.test(user)) return { ok: false, message: 'Invalid vote.' };
        poll.votes[user] = option;
      }
      poll.revision++;
      atomicJSON(file, poll);
      try { requireOK(await client.chat.update({ channel, ts: poll.ts, ...pollMessage(poll) })); }
      catch { return { ok: false, threadTs: poll.threadTs, message: 'Your change was saved, but Slack could not refresh the poll. Click again to refresh it.' }; }
      return { ok: true, threadTs: poll.threadTs };
    });
  }
}
