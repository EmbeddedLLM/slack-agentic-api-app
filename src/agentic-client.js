import WebSocket from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class AgenticError extends Error {
  constructor(message, code = '') {
    super(message);
    this.name = 'AgenticError';
    this.code = code;
  }
}

export function atomicJSON(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function readJSON(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new AgenticError('Saved state could not be read. Ask an admin to inspect the state directory.');
  }
}

export function scopeKey(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

// Only these gateway-owned tools are currently exposed. No local command execution.
export function gatewayTools(names = '', domains = []) {
  const requested = [...new Set(names.split(',').map(x => x.trim()).filter(Boolean))];
  for (const name of requested) {
    if (name !== 'web_search') throw new AgenticError(`Unsupported agent tool: ${name}. Supported: web_search.`);
  }
  return requested.map(type => ({ type, ...(domains.length ? { filters: { allowed_domains: domains } } : {}) }));
}

export function outputText(response) {
  const parts = (response.output || [])
    .filter(item => item.type === 'message' && item.role === 'assistant')
    .flatMap(item => item.content || []);
  const text = parts.map(part => part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : '').filter(Boolean).join('\n');
  const citations = new Map();
  for (const part of parts) {
    for (const a of part.annotations || []) {
      if (a.type === 'url_citation' && /^https?:\/\//i.test(a.url)) citations.set(a.url, a.title || a.url);
    }
  }
  const missing = [...citations].filter(([url]) => !text.includes(url));
  return text + (missing.length ? '\n\nSources:\n' + missing.map(([url, title]) => `- [${title.replace(/[\[\]\n]/g, ' ')}](${url.replace(/\)/g, '%29')})`).join('\n') : '');
}

export function validateResponse(response) {
  if (!response || response.status !== 'completed' || typeof response.id !== 'string') {
    throw new AgenticError('The gateway did not complete the response.', response?.status);
  }
  if (!Array.isArray(response.output)) throw new AgenticError('The gateway returned an invalid output.');
  const pending = response.output.find(item => ['function_call', 'custom_tool_call', 'shell_call', 'local_shell_call', 'mcp_approval_request'].includes(item.type));
  if (pending) throw new AgenticError(`The gateway requested an unsupported client tool (${pending.type}).`);
  const failed = response.output.find(item => item.type === 'web_search_call' && item.status === 'failed');
  if (failed) throw new AgenticError('Web search failed. Check the gateway search provider configuration.', 'web_search_failed');
  if (!outputText(response).trim()) throw new AgenticError('The model returned no answer. Check the model and its tool-call parser.');
  return response;
}

// A connection belongs to one Slack job. Research reuses it between sections.
// Closing it cancels that job without interrupting any other user's connection.
export class AgenticClient {
  constructor({ url, token = '', model, timeoutMs = 180_000, maxFrameBytes = 16 * 1024 * 1024, maxRequestBytes = 10 * 1024 * 1024, maxOutputTokens = 8192 } = {}) {
    const endpoint = new URL(url);
    if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
      throw new AgenticError('AGENTIC_WS_URL must be a ws:// or wss:// URL without credentials, query, or fragment.');
    }
    if (!endpoint.pathname.endsWith('/v1/responses')) throw new AgenticError('AGENTIC_WS_URL must end in /v1/responses.');
    if (!model?.trim()) throw new AgenticError('AGENTIC_MODEL must match a model served by the gateway.');
    this.url = endpoint.href;
    this.token = token;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    this.maxRequestBytes = maxRequestBytes;
    this.maxOutputTokens = maxOutputTokens;
    this.socket = null;
    this.busy = false;
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    // terminate also interrupts a pending upgrade; keep an error listener installed.
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  async respond({ input, tools = [], previousResponseId, store = true, signal, onEvent, maxToolCalls = 12, instructions } = {}) {
    if (this.busy) throw new AgenticError('This job already has an active response.');
    if (signal?.aborted) throw signal.reason || new DOMException('Cancelled', 'AbortError');
    const streamId = randomUUID();
    const frame = JSON.stringify({
      type: 'response.create', stream_id: streamId, model: this.model, input,
      tools, store, stream: true, max_output_tokens: this.maxOutputTokens, max_tool_calls: maxToolCalls,
      ...(tools.some(t => t.type === 'web_search') ? { include: ['web_search_call.action.sources'] } : {}),
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      ...(instructions ? { instructions } : {}),
    });
    if (Buffer.byteLength(frame) > this.maxRequestBytes) throw new AgenticError('The request is too large. Share fewer or smaller attachments.');
    this.busy = true;
    try {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        this.close();
        this.socket = new WebSocket(this.url, {
          headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
          handshakeTimeout: Math.min(this.timeoutMs, 15_000),
          maxPayload: this.maxFrameBytes,
          followRedirects: false,
          perMessageDeflate: false,
        });
        this.socket.on('error', () => {});
      }
      const socket = this.socket;
      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          for (const [event, listener] of listeners) socket.off(event, listener);
          if (error) { this.close(); reject(error); }
          else resolve(value);
        };
        const abort = () => finish(signal.reason || new DOMException('Cancelled', 'AbortError'));
        const timer = setTimeout(() => finish(new AgenticError('The gateway request timed out.', 'timeout')), this.timeoutMs);
        const open = () => socket.send(frame, error => { if (error) finish(new AgenticError('Could not send the WebSocket request.')); });
        const message = (data, binary) => {
          try {
            if (binary) throw new AgenticError('Expected a JSON text frame from the gateway.');
            const event = JSON.parse(data.toString());
            if (event.stream_id && event.stream_id !== streamId) return;
            if (event.type === 'error') {
              const code = typeof event.error?.code === 'string' ? event.error.code : '';
              const missing = code === 'previous_response_not_found';
              throw new AgenticError(missing
                ? 'Thread memory is no longer available on the gateway. Start a new Slack thread.'
                : 'The gateway rejected the request. Check the gateway logs and configuration.', code);
            }
            if (['response.failed', 'response.incomplete'].includes(event.type)) {
              throw new AgenticError('The model response did not finish. Try a smaller request or raise the output limit.', event.type);
            }
            onEvent?.(event);
            if (event.type === 'response.completed') finish(null, validateResponse(event.response));
          } catch (error) {
            finish(error instanceof AgenticError ? error : new AgenticError('Invalid event received from the gateway.'));
          }
        };
        const listeners = [
          ['open', open], ['message', message],
          ['error', () => finish(new AgenticError('WebSocket connection failed. Check the gateway URL, token, and proxy upgrade support.'))],
          ['close', () => finish(new AgenticError('WebSocket disconnected before the answer completed. The request was not retried.'))],
        ];
        for (const [event, listener] of listeners) socket.on(event, listener);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        else if (socket.readyState === WebSocket.OPEN) open();
      });
    } finally {
      this.busy = false;
    }
  }
}

export function clientSettings(env = process.env) {
  const positive = (name, fallback) => {
    const value = Number(env[name] || fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new AgenticError(`${name} must be a positive integer.`);
    return value;
  };
  return {
    url: env.AGENTIC_WS_URL || 'ws://127.0.0.1:9000/v1/responses',
    token: env.AGENTIC_API_KEY || '',
    model: env.AGENTIC_MODEL,
    timeoutMs: positive('AGENTIC_TIMEOUT_MS', 180_000),
    maxOutputTokens: positive('AGENTIC_MAX_OUTPUT_TOKENS', 8192),
    maxRequestBytes: positive('AGENTIC_MAX_REQUEST_BYTES', 10 * 1024 * 1024),
  };
}
