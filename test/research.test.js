import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgenticClient, readJSON } from '../src/agentic-client.js';
import { executeResearch } from '../src/research.js';
import { fakeGateway, response, searchItem } from './helpers/gateway.js';

const plan = { question: 'Compare databases', cover: ['Latency', 'Costs'], depth: 'deep', answers: [], domains: ['example.org'] };

test('research resumes after completed sections using a new WebSocket connection', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentic-research-test-'));
  let paused = false;
  let reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const gateway = await fakeGateway(({ request, complete }) => {
    if (request.tools.length && request.previous_response_id && !paused) { paused = true; reached(); return; }
    complete('Supported evidence [source](https://example.org/source)', { output: [...(request.tools.length ? [searchItem] : []), ...response('Supported evidence [source](https://example.org/source)').output] });
  });
  const clients = [];
  const create = () => { const c = new AgenticClient({ url: gateway.url, model: 'test-model' }); clients.push(c); return c; };
  t.after(async () => { clients.forEach(c => c.close()); await gateway.close(); rmSync(dir, { recursive: true }); });
  const controller = new AbortController();
  const running = executeResearch({ client: create(), runsDir: dir, plan, signal: controller.signal });
  const rejected = assert.rejects(running, /cancelled/);
  await waiting;
  controller.abort(new Error('cancelled'));
  await rejected;
  const checkpoint = path.join(dir, readdirSync(dir)[0], 'checkpoint.partial.json');
  const saved = readJSON(checkpoint);
  assert.equal(saved.sections.length, 1);
  assert.equal(saved.previousResponseId, 'resp_1');
  const report = await executeResearch({ client: create(), runsDir: dir, resume: checkpoint });
  assert.equal(report.sources, 1);
  assert.equal(readJSON(checkpoint), null);
  assert.equal(readJSON(report.art.json).sections.length, 2);
  assert.equal(gateway.connections.length, 2);
  assert.equal(gateway.requests[2].previous_response_id, 'resp_1');
  assert.match(gateway.requests[2].input, /Costs/);
  assert.deepEqual(gateway.requests[2].tools[0].filters, { allowed_domains: ['example.org'] });
  assert.deepEqual(gateway.requests.slice(-2).map(r => r.tools), [[], []]);
});

test('research does not claim success without retrieved sources', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentic-research-test-'));
  const gateway = await fakeGateway(({ complete }) => complete('I researched this from memory.'));
  const client = new AgenticClient({ url: gateway.url, model: 'test-model' });
  t.after(async () => { client.close(); await gateway.close(); rmSync(dir, { recursive: true }); });
  await assert.rejects(executeResearch({ client, runsDir: dir, plan }), /did not retrieve/);
  assert.equal(readJSON(path.join(dir, readdirSync(dir)[0], 'checkpoint.partial.json')).sections.length, 0);
  await assert.rejects(executeResearch({ client, runsDir: dir, resume: '/tmp/outside/checkpoint.partial.json' }), /does not belong/);
});

test('research redeclares multi-agent mode and preserves permissions in checkpoints', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentic-research-multi-'));
  const gateway = await fakeGateway(({ complete, request }) => complete('Evidence', { output: [...(request.tools.length ? [searchItem] : []), ...response('Evidence').output] }));
  const client = new AgenticClient({ url: gateway.url, model: 'test-model' });
  t.after(async () => { client.close(); await gateway.close(); rmSync(dir, { recursive: true }); });
  const multiAgent = { enabled: true, max_concurrent_subagents: 2 };
  const report = await executeResearch({ client, runsDir: dir, plan, tools: 'web_search,code_interpreter,file_search', vectorStoreIds: ['vs_research'], multiAgent });
  assert.ok(gateway.requests.every(request => request.multi_agent.max_concurrent_subagents === 2 && !Object.hasOwn(request, 'max_tool_calls')));
  assert.deepEqual(gateway.requests[0].tools.map(tool => tool.type), ['web_search', 'code_interpreter', 'file_search']);
  assert.deepEqual(readJSON(report.art.json).execution.vectorStoreIds, ['vs_research']);
});

test('resume refuses revoked tools, stores and delegation permissions before inference', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentic-research-permissions-'));
  const gateway = await fakeGateway(({ complete }) => complete('No sources available.'));
  const client = new AgenticClient({ url: gateway.url, model: 'test-model' });
  t.after(async () => { client.close(); await gateway.close(); rmSync(dir, { recursive: true }); });
  const permissions = { tools: 'web_search,code_interpreter,file_search', vectorStoreIds: ['vs_team'], multiAgent: { enabled: true, max_concurrent_subagents: 2 } };
  await assert.rejects(executeResearch({ client, runsDir: dir, plan, ...permissions }), /did not retrieve/);
  const checkpoint = path.join(dir, readdirSync(dir)[0], 'checkpoint.partial.json');
  for (const change of [{ tools: 'web_search,file_search' }, { vectorStoreIds: ['vs_other'] }, { multiAgent: null }]) {
    await assert.rejects(executeResearch({ client, runsDir: dir, resume: checkpoint, ...permissions, ...change }), /no longer allowed/);
  }
  assert.equal(gateway.requests.length, 1);
});
