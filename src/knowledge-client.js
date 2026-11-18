import { AgenticError } from './agentic-client.js';

// As in the playground, upload/index administration uses the Files HTTP APIs.
// Model inference and file_search execution continue over the Responses WebSocket.
export class KnowledgeClient {
  constructor({ url, token = '', timeoutMs = 180_000 }) {
    const endpoint = new URL(url);
    if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !endpoint.pathname.endsWith('/v1/responses')) {
      throw new AgenticError('Use a valid AGENTIC_WS_URL ending in /v1/responses.');
    }
    endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
    endpoint.pathname = endpoint.pathname.slice(0, -'/responses'.length);
    this.base = endpoint.href.replace(/\/$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request(route, body, multipart = false) {
    const response = await fetch(`${this.base}${route}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(multipart ? {} : { 'Content-Type': 'application/json' }) },
      body: multipart ? body : JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AgenticError(`Gateway file operation failed (HTTP ${response.status}). Check gateway logs, file format, and size limits.`);
    }
    return response.json();
  }

  create(name, fileIds = []) {
    return this.request('/vector_stores', { name, ...(fileIds.length ? { file_ids: fileIds } : {}) });
  }

  async upload(bytes, filename) {
    if (bytes.length > 20 * 1024 * 1024) throw new AgenticError('Gateway uploads are limited to 20 MiB; the configured request limit may be smaller.');
    const body = new FormData();
    body.append('purpose', 'assistants');
    body.append('file', new Blob([bytes]), filename);
    const result = await this.request('/files', body, true);
    if (!result.id) throw new AgenticError('The gateway returned no uploaded file ID.');
    return result;
  }

  attach(storeId, fileId) {
    if (!/^[\w-]{1,128}$/.test(storeId)) throw new AgenticError('Invalid vector store ID.');
    return this.request(`/vector_stores/${encodeURIComponent(storeId)}/files`, { file_id: fileId });
  }
}
