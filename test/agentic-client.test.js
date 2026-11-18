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

test('multi-agent requests omit incompatible budgets and only show the root answer', async t => {
  const multiAgent = { enabled: true, max_concurrent_subagents: 3 };
  const { client, gateway } = await fixture(t, ({ complete }) => complete('combined', { output: [
    { ...response('private child report').output[0], agent: { agent_name: '/root/worker' } },
    { ...response('working').output[0], agent: { agent_name: '/root' }, phase: 'commentary' },
    { ...response('combined').output[0], agent: { agent_name: '/root' }, phase: 'final_answer' },
    { type: 'code_interpreter_call', status: 'completed', outputs: [{ type: 'logs', logs: '42' }] },
  ] }));
  const result = await client.respond({ input: 'delegate', multiAgent, tools: gatewayTools('web_search,code_interpreter') });
  assert.equal(outputText(result), 'combined');
  assert.deepEqual(gateway.requests[0].multi_agent, multiAgent);
  assert.ok(!Object.hasOwn(gateway.requests[0], 'max_tool_calls'));
  assert.deepEqual(gateway.requests[0].tools[1], { type: 'code_interpreter', container: { type: 'auto' } });
});

test('file search uses only configured stores and renders filename citations', async t => {
  const tools = gatewayTools('web_search,file_search', [], ['vs_handbook']);
  const answer = response('Five days 【file_1】');
  answer.output[0].content[0].annotations.push({ type: 'file_citation', file_id: 'file_1', filename: 'handbook.md', index: 10 });
  const { client, gateway } = await fixture(t, ({ complete }) => complete('', answer));
  assert.match(outputText(await client.respond({ input: 'leave policy', tools })), /Five days \(handbook.md\)/);
  assert.deepEqual(gateway.requests[0].tools[1].vector_store_ids, ['vs_handbook']);
  assert.deepEqual(gateway.requests[0].include, ['web_search_call.action.sources', 'file_search_call.results']);
  assert.throws(() => gatewayTools('file_search'), /vectorStoreIds/);
});

test('native input_file content is sent unchanged over the WebSocket', async t => {
  const { client, gateway } = await fixture(t, ({ complete }) => complete('read it'));
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_file', filename: 'notes.txt', file_data: 'data:text/plain;base64,aGk=' }] }];
  await client.respond({ input });
  assert.deepEqual(gateway.requests[0].input, input);
});

for (const status of ['failed', 'incomplete']) {
  test(`unsuccessful interpreter execution (${status}) is not claimed as success`, async t => {
    const { client } = await fixture(t, ({ complete }) => complete('done', { output: [...response().output, { type: 'code_interpreter_call', status }] }));
    await assert.rejects(client.respond({ input: 'compute' }), /Code execution did not complete/);
  });
}

test('steering waits for the automatic successor and commits its final answer', async t => {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const { client, gateway } = await fixture(t, ({ request, send }) => {
    if (request.type === 'response.create') return send({ type: 'response.created', response: { id: 'parent', status: 'in_progress' } });
    send({ type: 'response.steer.accepted', steer: { id: 'steer_1', previous_response_id: 'parent' } });
    send({ type: 'response.incomplete', response: { id: 'parent', status: 'incomplete', incomplete_details: { reason: 'steered' } } });
    send({ type: 'response.created', response: { id: 'successor', previous_response_id: 'parent', status: 'in_progress' } });
    send({ type: 'response.completed', response: response('updated answer', { id: 'successor' }) });
  });
  const pending = client.respond({ input: 'original', onEvent: event => { if (event.type === 'response.created') ready(); } });
  await started;
  assert.equal((await client.steer('use Fahrenheit')).responseId, 'successor');
  assert.equal(outputText(await pending), 'updated answer');
  assert.deepEqual(gateway.requests[1], { type: 'response.steer', previous_response_id: 'parent', input: 'use Fahrenheit' });
  assert.equal(gateway.connections.length, 1);
});

test('a completed parent is not returned while steering awaits acceptance', async t => {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const { client } = await fixture(t, ({ request, send }) => {
    if (request.type === 'response.create') return send({ type: 'response.created', response: { id: 'parent' } });
    send({ type: 'response.completed', response: response('old answer', { id: 'parent' }) });
    send({ type: 'response.steer.accepted', steer: { id: 'steer_1', previous_response_id: 'parent' } });
    send({ type: 'response.created', response: { id: 'next', previous_response_id: 'parent' } });
    send({ type: 'response.completed', response: response('new answer', { id: 'next' }) });
  });
  const pending = client.respond({ input: 'x', onEvent: event => { if (event.type === 'response.created') ready(); } });
  await started;
  await client.steer('update');
  assert.equal(outputText(await pending), 'new answer');
});

test('rejected steering leaves the completed parent answer available', async t => {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const { client } = await fixture(t, ({ request, send }) => {
    if (request.type === 'response.create') return send({ type: 'response.created', response: { id: 'parent' } });
    send({ type: 'response.completed', response: response('original answer', { id: 'parent' }) });
    send({ type: 'response.steer.failed', steer: { previous_response_id: 'parent', input: request.input }, error: { code: 'response_not_active', message: 'do not echo me' } });
  });
  const pending = client.respond({ input: 'x', onEvent: event => { if (event.type === 'response.created') ready(); } });
  await started;
  await assert.rejects(client.steer('update'), /could not apply/);
  assert.equal(outputText(await pending), 'original answer');
});

test('steering failure after a steered parent never commits the partial answer', async t => {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const { client } = await fixture(t, ({ request, send }) => {
    if (request.type === 'response.create') return send({ type: 'response.created', response: { id: 'parent' } });
    send({ type: 'response.steer.accepted', steer: { id: 's', previous_response_id: 'parent' } });
    send({ type: 'response.incomplete', response: { id: 'parent', incomplete_details: { reason: 'steered' } } });
    send({ type: 'response.steer.failed', steer: { id: 's', previous_response_id: 'parent' }, error: { code: 'successor_creation_failed' } });
  });
  const pending = client.respond({ input: 'x', onEvent: event => { if (event.type === 'response.created') ready(); } });
  const failed = assert.rejects(pending, /did not finish/);
  await started;
  await assert.rejects(client.steer('update'), /could not apply/);
  await failed;
});

test('multi-agent steering is rejected locally without sending a control frame', async t => {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const { client, gateway } = await fixture(t, ({ send }) => send({ type: 'response.created', response: { id: 'parent' } }));
  const controller = new AbortController();
  const pending = client.respond({ input: 'x', multiAgent: { enabled: true, max_concurrent_subagents: 2 }, signal: controller.signal, onEvent: ready });
  const failed = assert.rejects(pending, /cancelled/);
  await started;
  assert.throws(() => client.steer('update'), /multiple agents/);
  assert.equal(gateway.requests.length, 1);
  controller.abort(new Error('cancelled'));
  await failed;
});

for (const store of [true, false]) {
  test(`authorized local function returns its output over the WebSocket (store=${store})`, async t => {
    const call = { type: 'function_call', name: 'create_sticker', call_id: 'call_sticker', arguments: '{"filename":"cat.gif"}' };
    const { client, gateway } = await fixture(t, ({ index, complete }) => index === 0 ? complete('', { output: [call] }) : complete('Here is your sticker.'));
    let executions = 0;
    const tools = [{ type: 'function', name: 'create_sticker', parameters: { type: 'object' } }];
    const result = await client.respond({ input: 'Draw a cat.', tools, store, multiAgent: { enabled: true, max_concurrent_subagents: 2 }, functionHandlers: {
      create_sticker: async raw => { executions++; assert.equal(JSON.parse(raw).filename, 'cat.gif'); return { ok: true, filename: 'cat.gif' }; },
    } });
    assert.equal(outputText(result), 'Here is your sticker.');
    assert.equal(executions, 1);
    assert.deepEqual(gateway.requests[1].tools, tools);
    assert.equal(gateway.requests[1].multi_agent.enabled, true);
    assert.equal(gateway.requests[1].input.at(-1).type, 'function_call_output');
    assert.equal(gateway.requests[1].input.at(-1).call_id, 'call_sticker');
    if (store) assert.equal(gateway.requests[1].previous_response_id, 'resp_1');
    else { assert.equal(gateway.requests[1].previous_response_id, undefined); assert.deepEqual(gateway.requests[1].input[1], call); }
  });
}

test('a handler alone does not authorize an undeclared local function', async t => {
  const { client } = await fixture(t, ({ complete }) => complete('', { output: [{ type: 'function_call', name: 'create_sticker', call_id: 'c', arguments: '{}' }] }));
  let called = false;
  await assert.rejects(client.respond({ input: 'x', functionHandlers: { create_sticker: () => { called = true; } } }), /unsupported client tool/);
  assert.equal(called, false);
});
