import { WebSocketServer } from 'ws';
import { once } from 'node:events';

export function response(text = 'normal answer', extra = {}) {
  return { id: 'resp_test', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }], ...extra };
}

export async function fakeGateway(handler) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const requests = [];
  const connections = [];
  let n = 0;
  server.on('connection', (socket, upgrade) => {
    connections.push({ socket, headers: upgrade.headers, path: upgrade.url });
    socket.on('error', () => {});
    socket.on('message', async data => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      const id = `resp_${++n}`;
      const send = event => { if (socket.readyState === 1) socket.send(JSON.stringify({ stream_id: request.stream_id, ...event })); };
      const complete = (text, extra = {}) => {
        send({ type: 'response.created', response: { id, status: 'in_progress', output: [] } });
        send({ type: 'response.output_text.delta', delta: text });
        send({ type: 'response.completed', response: response(text, { id, ...extra }) });
      };
      await handler({ request, socket, send, complete, id, index: requests.length - 1 });
    });
  });
  return {
    url: `ws://127.0.0.1:${server.address().port}/v1/responses`, requests, connections,
    async close() { for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); },
  };
}

export const searchItem = { type: 'web_search_call', id: 'search_1', status: 'completed', action: { type: 'search', query: 'evidence', sources: [{ url: 'https://example.org/source', title: 'Source' }] } };
export const promptText = request => typeof request.input === 'string' ? request.input : request.input.flatMap(message => message.content || []).filter(part => part.type === 'input_text').map(part => part.text).join('\n');
