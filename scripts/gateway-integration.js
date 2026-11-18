// Opt-in protocol check with a real gateway and deterministic HTTP/SSE inference.
// Usage: AGENTIC_SERVER_BIN=/path/to/agentic-server node scripts/gateway-integration.js
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgenticClient, outputText } from '../src/agentic-client.js';

const binary = process.env.AGENTIC_SERVER_BIN;
if (!binary) throw new Error('Set AGENTIC_SERVER_BIN to the gateway executable.');
const state = mkdtempSync(path.join(os.tmpdir(), 'slack-agentic-real-gateway-'));
const inputs = [];
let n = 0;
const upstream = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model', object: 'model', owned_by: 'test' }] }));
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  inputs.push(body);
  const id = `resp_upstream_${++n}`;
  const itemId = `msg_${n}`;
  const text = `Gateway answer ${n}`;
  const part = { type: 'output_text', text, annotations: [] };
  const item = { type: 'message', id: itemId, role: 'assistant', status: 'completed', content: [part] };
  const response = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: 'test-model', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  if (!body.stream) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(response)); }
  res.setHeader('Content-Type', 'text/event-stream');
  let sequence = 0;
  const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
  send({ type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } });
  send({ type: 'response.in_progress', response: { ...response, status: 'in_progress', output: [], usage: null } });
  send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  send({ type: 'response.content_part.added', output_index: 0, item_id: itemId, content_index: 0, part: { ...part, text: '' } });
  send({ type: 'response.output_text.delta', output_index: 0, item_id: itemId, content_index: 0, delta: text });
  send({ type: 'response.output_text.done', output_index: 0, item_id: itemId, content_index: 0, text });
  send({ type: 'response.content_part.done', output_index: 0, item_id: itemId, content_index: 0, part });
  send({ type: 'response.output_item.done', output_index: 0, item });
  send({ type: 'response.completed', response });
  res.end();
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const reserve = createServer();
reserve.listen(0, '127.0.0.1');
await once(reserve, 'listening');
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
let logs = '';
const server = spawn(binary, ['--llm-api-base', `http://127.0.0.1:${upstream.address().port}`, '--gateway-host', '127.0.0.1', '--gateway-port', String(port), '--skip-llm-ready-check'], {
  env: { PATH: process.env.PATH, HOME: state, AGENTIC_API_HOME: state, RUST_LOG: 'warn' }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
server.stderr.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
const client = new AgenticClient({ url: `ws://127.0.0.1:${port}/v1/responses`, model: 'test-model', timeoutMs: 5000 });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {}
    if (server.exitCode !== null) throw new Error(`Gateway exited: ${logs}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, `Gateway failed to start: ${logs}`);
  const first = await client.respond({ input: 'Remember the project is Acorn.' });
  assert.equal(outputText(first), 'Gateway answer 1');
  const second = await client.respond({ input: 'Continue on the same socket.', previousResponseId: first.id });
  assert.equal(outputText(second), 'Gateway answer 2');
  client.close();
  const third = await client.respond({ input: 'Continue after reconnecting.', previousResponseId: second.id });
  assert.equal(outputText(third), 'Gateway answer 3');
  assert.match(JSON.stringify(inputs[2].input), /Acorn/);
  assert.match(JSON.stringify(inputs[2].input), /Gateway answer 2/);
  console.log('PASS real gateway: WebSocket streaming, same-connection continuation, and persisted continuation after reconnect.');
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  client.close();
  server.kill('SIGTERM');
  if (server.exitCode === null) await once(server, 'exit');
  await new Promise(resolve => upstream.close(resolve));
  rmSync(state, { recursive: true, force: true });
}
