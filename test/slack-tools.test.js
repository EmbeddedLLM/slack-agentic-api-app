import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SlackTools, pollMessage } from '../src/slack-tools.js';

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'slack-tools-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const record = (method, result) => async args => { calls.push({ method, args }); return result; };
  const client = {
    chat: { postMessage: record('post', { ok: true, ts: '123.456' }), update: record('update', { ok: true }) },
    files: { uploadV2: record('upload', { ok: true, files: [{ ok: true, files: [{ id: 'FILE1' }] }] }),
      info: record('info', { ok: true, file: { permalink: 'https://workspace.slack.com/files/U1/FILE1/decisions.md' } }) },
    bookmarks: { add: record('bookmark', { ok: true, bookmark: { id: 'BK1' } }) },
  };
  const job = { channel: 'CCHANNEL', threadTs: '123.000', user: 'UOWNER', requestTs: '123.001' };
  const service = new SlackTools(dir);
  const opts = { client, job, authorize: async () => true, canSaveDocuments: true };
  const args = { question: 'Demo day?', options: ['Tuesday', 'Wednesday'] };
  const doc = { title: 'Decisions', filename: 'decisions.md', content: '# Decisions\n\nDemo on Tuesday. 🐈' };
  return { dir, calls, client, job, service, opts, args, doc, handlers: service.handlers(opts) };
}

test('poll creation is threaded and deduplicated, votes survive restart and concurrent updates', async t => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.handlers.create_poll(JSON.stringify(f.args)), f.handlers.create_poll(JSON.stringify(f.args))]);
  assert.deepEqual(a, b); assert.equal(a.ok, true);
  assert.equal(f.calls.filter(c => c.method === 'post').length, 1);
  assert.equal(f.calls[0].args.thread_ts, f.job.threadTs);
  assert.equal(f.calls[0].args.channel, f.job.channel);
  const restarted = new SlackTools(f.dir);
  const click = { client: f.client, id: a.poll_id, channel: f.job.channel, messageTs: a.message_ts, authorize: async () => ({ allowed: true }) };
  await Promise.all(['UA', 'UB', 'UC'].map(user => restarted.interact({ ...click, user, option: 0 })));
  await restarted.interact({ ...click, user: 'UA', option: 1 });
  await restarted.interact({ ...click, user: 'UA', option: 1 }); // replay is not another vote
  const poll = JSON.parse(readFileSync(restarted.file(a.poll_id)));
  assert.deepEqual(poll.votes, { UA: 1, UB: 0, UC: 0 });
  assert.match(pollMessage(poll).text, /Tuesday — 2/);
  assert.match(f.calls.at(-1).args.text, /3 votes/);
  assert.equal((await restarted.handlers(f.opts).create_poll(JSON.stringify(f.args))).poll_id, a.poll_id);
  assert.equal(f.calls.filter(c => c.method === 'post').length, 1);
});

test('poll interactions bind to the posted message, enforce close ownership, and persist failed refreshes', async t => {
  const f = fixture(t), result = await f.handlers.create_poll(JSON.stringify(f.args));
  const click = { client: f.client, id: result.poll_id, channel: f.job.channel, messageTs: result.message_ts, user: 'UOTHER', authorize: async () => ({ allowed: true }) };
  assert.equal((await f.service.interact({ ...click, option: 0, channel: 'COTHER' })).ok, false);
  assert.equal((await f.service.interact({ ...click, option: 0, messageTs: '999.000' })).ok, false);
  assert.equal((await f.service.interact({ ...click, option: 99 })).ok, false);
  assert.equal((await f.service.interact({ ...click, close: true })).ok, false);
  assert.equal((await f.service.interact({ ...click, option: 0, authorize: async () => ({ allowed: false }) })).ok, false);
  f.client.chat.update = async () => { throw new Error('network error'); };
  assert.match((await f.service.interact({ ...click, option: 1 })).message, /saved/);
  assert.equal(JSON.parse(readFileSync(f.service.file(result.poll_id))).votes.UOTHER, 1);
  f.client.chat.update = async () => ({ ok: true });
  assert.equal((await f.service.interact({ ...click, user: 'UADMIN', close: true, authorize: async () => ({ allowed: true, admin: true }) })).ok, true);
  assert.equal((await f.service.interact({ ...click, option: 0 })).ok, false);
  const closed = pollMessage(JSON.parse(readFileSync(f.service.file(result.poll_id))));
  assert.ok(closed.blocks.every(block => !block.accessory && block.type !== 'actions'));
});

test('document writes UTF-8 Markdown, uploads into thread, and bookmarks Slack’s actual permalink once', async t => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.handlers.save_channel_document(JSON.stringify(f.doc)), f.handlers.save_channel_document(JSON.stringify(f.doc))]);
  assert.deepEqual(a, b); assert.equal(a.bookmarked, true);
  const upload = f.calls.find(c => c.method === 'upload').args;
  assert.equal(upload.file.toString('utf8'), f.doc.content);
  assert.equal(upload.thread_ts, f.job.threadTs); assert.equal(upload.channel_id, f.job.channel);
  assert.equal(f.calls.filter(c => c.method === 'upload').length, 1);
  assert.deepEqual(f.calls.find(c => c.method === 'bookmark').args, { channel_id: f.job.channel, title: f.doc.title, type: 'link', link: a.url });
  assert.equal(f.calls.filter(c => c.method === 'bookmark').length, 1);
});

test('bookmark failure preserves the uploaded file and reports partial success without duplicate uploads', async t => {
  const f = fixture(t);
  f.client.bookmarks.add = async () => ({ ok: false, error: 'missing_scope' });
  const result = await f.handlers.save_channel_document(JSON.stringify(f.doc));
  assert.equal(result.ok, false); assert.equal(result.uploaded, true); assert.equal(result.bookmarked, false);
  assert.match(result.error, /bookmarks:write/); assert.match(result.url, /FILE1/);
  assert.deepEqual(await f.handlers.save_channel_document(JSON.stringify(f.doc)), result);
  assert.equal(f.calls.filter(c => c.method === 'upload').length, 1);
});

test('validation, cancellation, permission revocation and uncertain writes never cause extra Slack actions', async t => {
  const f = fixture(t);
  assert.equal((await f.handlers.create_poll(JSON.stringify({ ...f.args, options: ['Yes', ' yes '] }))).ok, false);
  assert.equal((await f.handlers.create_poll(JSON.stringify({ ...f.args, channel: 'COTHER' }))).ok, false);
  assert.equal((await f.handlers.save_channel_document(JSON.stringify({ ...f.doc, filename: '../leak.md' }))).ok, false);
  assert.equal((await f.handlers.save_channel_document(JSON.stringify({ ...f.doc, content: 'x'.repeat(200001) }))).ok, false);
  const denied = f.service.handlers({ ...f.opts, authorize: async () => false });
  assert.equal((await denied.create_poll(JSON.stringify(f.args))).ok, false);
  await assert.rejects(f.handlers.create_poll(JSON.stringify(f.args), { signal: AbortSignal.abort() }));
  assert.equal(f.calls.length, 0);
  let posts = 0;
  f.client.chat.postMessage = async () => { posts++; throw new Error('Connection lost after possible delivery'); };
  const result = await f.handlers.create_poll(JSON.stringify(f.args));
  assert.equal(result.ok, false);
  assert.deepEqual(await f.handlers.create_poll(JSON.stringify(f.args)), result);
  assert.equal(posts, 1);
  assert.equal(f.job.slackActionsAttempted, true);
});

test('permission change after upload stops bookmarking and invalid links are never bookmarked', async t => {
  const f = fixture(t);
  let checks = 0;
  const handlers = f.service.handlers({ ...f.opts, authorize: async () => ++checks === 1 });
  const result = await handlers.save_channel_document(JSON.stringify(f.doc));
  assert.equal(result.uploaded, true); assert.equal(result.bookmarked, false);
  assert.ok(!f.calls.some(c => c.method === 'bookmark'));
  f.client.files.info = async () => ({ ok: true, file: { permalink: 'https://evil.example/stolen' } });
  const badLink = await f.handlers.save_channel_document(JSON.stringify({ ...f.doc, filename: 'other.md' }));
  assert.equal(badLink.bookmarked, false);
  assert.ok(!f.calls.some(c => c.method === 'bookmark'));
});
