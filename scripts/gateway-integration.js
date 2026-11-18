// Opt-in integration: actual gateway/tools; deterministic model, no Slack/provider keys.
// AGENTIC_SERVER_BIN=.runtime/agentic-api/target/release/agentic-server node scripts/gateway-integration.js
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgenticClient, gatewayTools, outputText } from '../src/agentic-client.js';
import { KnowledgeClient } from '../src/knowledge-client.js';

const binary = process.env.AGENTIC_SERVER_BIN;
if (!binary) throw new Error('Set AGENTIC_SERVER_BIN to the source-built gateway executable.');
const state = mkdtempSync(path.join(os.tmpdir(), 'slack-agentic-real-gateway-'));
const inputs = [];
let n = 0, scenario = '', fileId = '', paused;
const message = text => ({ type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const call = (name, args) => ({ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name, arguments: JSON.stringify(args), status: 'completed' });
const upstream = createServer(async (req, res) => {
  if (req.method === 'GET') return res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model', object: 'model', owned_by: 'test' }] }));
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  inputs.push(body);
  n++;
  let item = message(`Gateway answer ${n}`);
  if (scenario === 'python') { item = call('code_interpreter', { code: 'print(6 * 7)' }); scenario = 'python-result'; }
  else if (scenario === 'python-result') {
    item = message('Python returned 42.');
    assert.ok(body.input.some(item => item.type === 'function_call_output' && JSON.stringify(item.output).includes('42')));
  } else if (scenario === 'search') { item = call('file_search', { queries: ['coral'] }); scenario = 'search-result'; }
  else if (scenario === 'search-result') {
    assert.ok(body.input.some(item => item.type === 'function_call_output' && JSON.stringify(item.output).includes('coral reefs')));
    item = message(`The policy protects coral reefs. 【${fileId}】`);
  } else if (scenario === 'steer-result') { item = message('Updated answer about costs.'); }
  const response = { id: `resp_upstream_${n}`, object: 'response', created_at: Math.floor(Date.now()/1000), model: 'test-model', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  if (!body.stream) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(response)); }
  res.setHeader('Content-Type', 'text/event-stream');
  let sequence = 0;
  const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
  send({ type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } });
  send({ type: 'response.in_progress', response: { ...response, status: 'in_progress', output: [], usage: null } });
  send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : {}) } });
  if (item.type === 'message') {
    const part = item.content[0], itemId = item.id, text = part.text;
    send({ type: 'response.content_part.added', output_index: 0, item_id: itemId, content_index: 0, part: { ...part, text: '' } });
    send({ type: 'response.output_text.delta', output_index: 0, item_id: itemId, content_index: 0, delta: text });
    if (scenario === 'steer') { scenario = 'steer-result'; paused(); await new Promise(resolve => setTimeout(resolve, 1000)); }
    send({ type: 'response.output_text.done', output_index: 0, item_id: itemId, content_index: 0, text });
    send({ type: 'response.content_part.done', output_index: 0, item_id: itemId, content_index: 0, part });
  } else send({ type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments });
  send({ type: 'response.output_item.done', output_index: 0, item });
  send({ type: 'response.completed', response });
  res.end();
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const reserve = createServer().listen(0, '127.0.0.1');
await once(reserve, 'listening');
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
let logs = '';
const server = spawn(binary, ['--llm-api-base', `http://127.0.0.1:${upstream.address().port}`, '--gateway-host', '127.0.0.1', '--gateway-port', String(port), '--skip-llm-ready-check'], {
  env: { PATH: process.env.PATH, HOME: state, AGENTIC_API_HOME: state, RUST_LOG: 'warn', AGENTIC_CODE_INTERPRETER_ENABLED: 'true',
    ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
    ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
  }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', chunk => { logs = (logs + chunk).slice(-20000); });
server.stderr.on('data', chunk => { logs = (logs + chunk).slice(-20000); });
const url = `ws://127.0.0.1:${port}/v1/responses`;
const client = new AgenticClient({ url, model: 'test-model', timeoutMs: 30000 });
try {
  let ready = false;
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {}
    if (server.exitCode !== null) throw new Error(`Gateway exited: ${logs}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Gateway failed to start: ${logs}`);
  const first = await client.respond({ input: 'Remember the project is Acorn.' });
  const second = await client.respond({ input: 'Continue on the same socket.', previousResponseId: first.id });
  client.close();
  const third = await client.respond({ input: 'Continue after reconnecting.', previousResponseId: second.id });
  assert.equal(outputText(third), 'Gateway answer 3');
  assert.match(JSON.stringify(inputs[2].input), /Acorn/);
  assert.match(JSON.stringify(inputs[2].input), /Gateway answer 2/);
  console.log('PASS real gateway: streaming and persisted continuation after reconnect.');
  await client.respond({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read this.' }, { type: 'input_file', filename: 'note.txt', file_data: `data:text/plain;base64,${Buffer.from('Native document marker.').toString('base64')}` }] }] });
  assert.match(JSON.stringify(inputs.at(-1).input), /Native document marker/);
  console.log('PASS real gateway: native input_file normalization.');
  await client.respond({ input: 'Work as a team.', multiAgent: { enabled: true, max_concurrent_subagents: 2 } });
  assert.ok(inputs.at(-1).tools.some(tool => tool.name === 'spawn_agent'));
  console.log('PASS real gateway: multi-agent admission and collaboration tool injection.');
  scenario = 'python';
  const python = await client.respond({ input: 'Calculate.', tools: gatewayTools('code_interpreter') });
  const execution = python.output.find(item => item.type === 'code_interpreter_call');
  assert.equal(execution.status, 'completed');
  assert.match(JSON.stringify(execution.outputs), /42/);
  console.log('PASS real gateway: actual isolated Python worker executes print(6 * 7).');
  const knowledge = new KnowledgeClient({ url });
  fileId = (await knowledge.upload(Buffer.from('The policy protects coral reefs.'), 'policy.txt')).id;
  const store = await knowledge.create('Integration fixture', [fileId]);
  scenario = 'search';
  const found = await client.respond({ input: 'Find the coral policy.', tools: gatewayTools('file_search', [], [store.id]) });
  assert.ok(found.output.some(item => item.type === 'file_search_call' && item.status === 'completed' && item.results.some(result => result.file_id === fileId)));
  assert.match(outputText(found), /policy.txt/);
  console.log('PASS real gateway: upload, indexing, file search, and native file citations.');
  scenario = 'steer';
  const waiting = new Promise(resolve => { paused = resolve; });
  let created;
  const started = new Promise(resolve => { created = resolve; });
  const active = client.respond({ input: 'Start a long task.', onEvent: event => { if (event.type === 'response.created') created(); } });
  // Attach a rejection handler immediately while the fixture waits for upstream.
  active.catch(() => {});
  await Promise.race([Promise.all([waiting, started]), active.then(() => { throw new Error('Response finished before the steering fixture was ready.'); })]);
  const applied = await client.steer('Focus on costs.');
  const result = await active;
  assert.equal(result.id, applied.responseId);
  assert.match(outputText(result), /Updated answer about costs/);
  assert.match(JSON.stringify(inputs.at(-1).input), /Focus on costs/);
  console.log('PASS real gateway: response.steer acceptance, successor creation, and updated completion.');
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  client.close();
  server.kill('SIGTERM');
  if (server.exitCode === null) await once(server, 'exit');
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  rmSync(state, { recursive: true, force: true });
}
