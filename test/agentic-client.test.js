import test from 'node:test';
import assert from 'node:assert/strict';
import { AgenticClient, gatewayTools, outputText, scopeKey } from '../src/agentic-client.js';
import { fakeGateway, response } from './helpers/gateway.js';

async function fixture(t, handler, options = {}) {
  const gateway = await fakeGateway(handler);
  const client = new AgenticClient({ url: gateway.url, model: 'test-model', timeoutMs: 1000, ...options });
  t.after(async () => { client.close(); await gateway.close(); });
  return { gateway, client };
}

test('native WebSocket frames, bearer upgrade, continuation and connection reuse', async t => {
  const { gateway, client } = await fixture(t, ({ send, complete }) => {
    send({ stream_id: 'other-job', type: 'error', error: { code: 'ignore_me' } });
    complete('answer');
  }, { token: 'gateway-token' });
  const first = await client.respond({ input: 'hello', tools: gatewayTools('web_search') });
  await client.respond({ input: 'follow up', previousResponseId: first.id });
  assert.equal(gateway.connections.length, 1);
  assert.equal(gateway.connections[0].headers.authorization, 'Bearer gateway-token');
  assert.equal(gateway.connections[0].path, '/v1/responses');
  assert.equal(gateway.requests[0].type, 'response.create');
  assert.equal(gateway.requests[0].store, true);
  assert.equal(gateway.requests[0].stream, true);
  assert.deepEqual(gateway.requests[0].include, ['web_search_call.action.sources']);
  assert.equal(gateway.requests[1].previous_response_id, first.id);
  assert.notEqual(gateway.requests[0].stream_id, gateway.requests[1].stream_id);
});

test('missing parent is surfaced without replay or retry', async t => {
  const { gateway, client } = await fixture(t, ({ send }) => send({ type: 'error', error: { code: 'previous_response_not_found', message: 'private-token-value' } }));
  await assert.rejects(client.respond({ input: 'x', previousResponseId: 'missing' }), /Start a new Slack thread/);
  assert.equal(gateway.requests.length, 1);
});

for (const type of ['response.failed', 'response.incomplete']) {
  test(`${type} is never committed as a successful answer`, async t => {
    const { client } = await fixture(t, ({ send }) => send({ type, response: response('partial') }));
    await assert.rejects(client.respond({ input: 'x' }), /did not finish/);
  });
}

test('connection loss after partial output fails without retry', async t => {
  const { client, gateway } = await fixture(t, ({ socket, send }) => { send({ type: 'response.output_text.delta', delta: 'partial' }); socket.close(); });
  await assert.rejects(client.respond({ input: 'x' }), /disconnected/);
  assert.equal(gateway.requests.length, 1);
});

test('malformed frames fail safely', async t => {
  const { client } = await fixture(t, ({ socket }) => socket.send('not-json'));
  await assert.rejects(client.respond({ input: 'x' }), /Invalid event/);
});

test('an unsupported tool is not treated as a final answer', async t => {
  const { client } = await fixture(t, ({ complete }) => complete('done', { output: [...response().output, { type: 'function_call', name: 'bash' }] }));
  await assert.rejects(client.respond({ input: 'x' }), /unsupported client tool/);
});

test('failed search is not silently presented as research', async t => {
  const { client } = await fixture(t, ({ complete }) => complete('done', { output: [...response().output, { type: 'web_search_call', status: 'failed' }] }));
  await assert.rejects(client.respond({ input: 'x' }), /Web search failed/);
});

test('timeout tears down the active request', async t => {
  const { client } = await fixture(t, () => {}, { timeoutMs: 40 });
  await assert.rejects(client.respond({ input: 'x' }), /timed out/);
  assert.equal(client.socket, null);
});

test('cancel affects only its job, not a concurrent connection', async t => {
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const { client, gateway } = await fixture(t, ({ request, complete }) => request.input === 'slow' ? started() : complete('fast answer'));
  const second = new AgenticClient({ url: gateway.url, model: 'test-model' });
  t.after(() => second.close());
  const controller = new AbortController();
  const pending = client.respond({ input: 'slow', signal: controller.signal });
  const rejection = assert.rejects(pending, /cancelled/);
  await waiting;
  controller.abort(new Error('cancelled'));
  assert.equal(outputText(await second.respond({ input: 'fast' })), 'fast answer');
  await rejection;
});

test('pre-aborted requests and oversized bodies never open a socket', async () => {
  const client = new AgenticClient({ url: 'ws://localhost:1/v1/responses', model: 'model', maxRequestBytes: 500 });
  await assert.rejects(client.respond({ input: 'x', signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
  await assert.rejects(client.respond({ input: 'x'.repeat(1000) }), /too large/);
  assert.equal(client.socket, null);
});

test('response frame limit is enforced by the WebSocket parser', async t => {
  const { client } = await fixture(t, ({ socket }) => socket.send('x'.repeat(4000)), { maxFrameBytes: 1024 });
  await assert.rejects(client.respond({ input: 'x' }), /connection failed/);
});

test('URLs, tools, citations and session scope are constrained', () => {
  assert.throws(() => new AgenticClient({ url: 'https://example.org/v1/responses', model: 'model' }), /ws:\/\//);
  assert.throws(() => new AgenticClient({ url: 'wss://secret@example.org/v1/responses', model: 'model' }), /credentials/);
  assert.throws(() => gatewayTools('bash'), /Unsupported/);
  assert.deepEqual(gatewayTools('web_search', ['example.org']), [{ type: 'web_search', filters: { allowed_domains: ['example.org'] } }]);
  const result = response('Fact');
  result.output[0].content[0].annotations.push({ type: 'url_citation', url: 'https://example.org', title: 'Evidence' });
  assert.match(outputText(result), /\[Evidence\]\(https:\/\/example.org\)/);
  assert.notEqual(scopeKey(['C1', 'thread', 'U1', 'admin']), scopeKey(['C1', 'thread', 'U1', 'viewer']));
});
