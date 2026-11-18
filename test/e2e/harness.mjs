// Slack methods are recorded in memory; Agentic API is a real local WebSocket test server.
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeGateway, promptText, response, searchItem } from '../helpers/gateway.js';

const NAMES = { UADMIN: 'Ada Admin', UMEM: 'Mo Member', UVIEW: 'Val Viewer' };
export async function startBot(extraEnv = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'slack-agentic-e2e-'));
  let mode = 'complete';
  const gateway = await fakeGateway(({ request, complete, send }) => {
    const prompt = promptText(request);
    if (/plan a deep web research job/.test(prompt)) {
      complete(JSON.stringify({ title: 'Vector DB comparison', question: 'Compare vector databases', depth: 'standard', cover: ['Latency', 'Cost'], domains: [], questions: [{ question: 'How many vectors?', options: [] }], answers: [] }));
    } else if (/Research this section now/.test(prompt)) {
      if (mode === 'slow') return;
      if (mode === 'failure') return send({ type: 'error', error: { code: 'provider_error' } });
      complete('Evidence from [source](https://example.org/source)', { output: [searchItem, ...response('Evidence from [source](https://example.org/source)').output] });
    } else if (/Write the full research report/.test(prompt)) complete('# Report\nMilvus and Qdrant have different tradeoffs. [source](https://example.org/source)');
    else if (/Summarize the report above/.test(prompt)) complete('Milvus and Qdrant have different tradeoffs. [source](https://example.org/source)');
    else if (mode === 'slowchat') return;
    else if (mode === 'file') complete('Here is the result.\n<slack_file name="result.csv">\na,b\n1,2\n</slack_file>');
    else if (mode === 'long') complete('normal answer '.repeat(1200));
    else complete(`normal answer${prompt.includes('<research_evidence>') ? ' from saved evidence' : ''}`);
  });
  writeFileSync(path.join(dir, 'access.json'), JSON.stringify({ defaultRole: 'none', users: { UADMIN: 'admin', UMEM: 'member', UVIEW: 'viewer' } }));
  Object.assign(process.env, {
    SLACK_BOT_TOKEN: 'xoxb-test-private-token', SLACK_APP_TOKEN: 'xapp-test-private-token',
    AGENTIC_WS_URL: gateway.url, AGENTIC_MODEL: 'test-model', AGENTIC_API_KEY: 'gateway-test-token',
    ACCESS_FILE: path.join(dir, 'access.json'), RESEARCH_DIR: path.join(dir, 'research'),
    AGENTIC_SESSION_DIR: path.join(dir, 'sessions'), HINTS_FILE: path.join(dir, 'hints.json'),
    INPUT_FILES_DIR: path.join(dir, 'inputs'), SLACK_REACTIONS: 'false',
    AGENTIC_TOOLS: 'web_search', AGENTIC_TOOLS_TRUSTED: 'web_search', ...extraEnv,
  });
  let ts = 1000;
  const calls = [];
  const record = m => async (a = {}) => {
    calls.push({ m, a });
    if (m === 'chat.postMessage') return { ok: true, ts: `${++ts}.000100` };
    if (m === 'users.info') return { user: { id: a.user, real_name: NAMES[a.user] || 'Nora Nobody', tz: 'UTC' } };
    if (m === 'conversations.replies' || m === 'conversations.history') return { messages: [] };
    if (m === 'conversations.info') return { channel: { name: 'general', is_channel: true } };
    if (m === 'auth.test') return { user_id: 'UBOT', bot_id: 'B1', user: 'test-bot' };
    return { ok: true };
  };
  const client = new Proxy({}, { get: (_, ns) => new Proxy({}, { get: (_, fn) => record(`${ns}.${fn}`) }) });
  globalThis.__client = client;
  await import('../../index.js');
  const app = globalThis.__app;
  await sleep(20);
  let n = 0;
  const bot = {
    dir, app, client, calls, gateway, lastTs: '', setMode: value => { mode = value; },
    agentCalls: () => gateway.requests.map(request => ({ ...request, prompt: promptText(request) })),
    mention(user, text, thread, files) {
      const event = { type: 'app_mention', user, text: `<@UBOT>${text ? ` ${text}` : ''}`, channel: 'C0TEST', ts: `${2000 + ++n}.000200`, ...(thread ? { thread_ts: thread } : {}), ...(files ? { files } : {}) };
      bot.lastTs = event.ts;
      return app.h.event.app_mention({ event, client });
    },
    dm(user, text) { return app.h.event.message({ event: { type: 'message', channel_type: 'im', user, text, channel: 'D0DM', ts: `${2000 + ++n}.000200` }, client }); },
    click(id, value, user = 'UADMIN', messageTs) {
      return app.h.action[id]({ ack: async () => {}, body: { user: { id: user }, channel: { id: 'C0TEST' }, trigger_id: 'T1', message: { ts: messageTs } }, action: { value }, client });
    },
    ephemerals: () => calls.filter(c => c.m === 'chat.postEphemeral').map(c => c.a.text),
    lastUpdate: pred => [...calls].reverse().find(c => c.m === 'chat.update' && pred(c.a)),
  };
  return bot;
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const J = x => JSON.stringify(x ?? []);
export async function until(fn, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) { const value = fn(); if (value) return value; await sleep(10); }
  throw new Error('timed out waiting for a condition');
}
let failures = 0;
export function ok(condition, label) { console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`); if (!condition) failures++; }
export function finish() { console.log(failures ? `${failures} checks failed` : 'all checks passed'); process.exit(failures ? 1 : 0); }
