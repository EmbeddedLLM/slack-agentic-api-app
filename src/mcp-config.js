import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { githubReadTools, githubMcpTool, kanbanMcpTool } from './mcp-tools.js';
import { stickerArtTool } from './sticker-art.js';

// Agentic API currently accepts literal HTTP headers in config.toml. Keep
// credentials in that private file, never in model input or Slack requests.
export function configureMcp(home, env) {
  const servers = [];
  if (env.STICKER_MCP_LABEL) {
    const tool = stickerArtTool(env.STICKER_MCP_LABEL);
    const port = Number(env.STICKER_MCP_PORT || 8189);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid STICKER_MCP_PORT.');
    servers.push({ label: tool.server_label, url: `http://127.0.0.1:${port}/mcp`, allowed: tool.allowed_tools });
  }
  if (env.GITHUB_MCP_LABEL) {
    githubMcpTool(env.GITHUB_MCP_LABEL);
    if (!env.GITHUB_MCP_TOKEN?.trim()) throw new Error('Set a public-only GITHUB_MCP_TOKEN in .env.gateway before enabling GITHUB_MCP_LABEL.');
    servers.push({ label: env.GITHUB_MCP_LABEL, url: 'https://api.githubcopilot.com/mcp/', allowed: githubReadTools,
      headers: { Authorization: `Bearer ${env.GITHUB_MCP_TOKEN.trim()}`, 'X-MCP-Readonly': 'true', 'X-MCP-Tools': githubReadTools.join(',') } });
  }
  if (env.VIBE_KANBAN_MCP_LABEL) {
    const tool = kanbanMcpTool(env.VIBE_KANBAN_MCP_LABEL);
    const key = env.VIBE_KANBAN_API_KEY?.trim();
    if (!key || /[\r\n]/.test(key)) throw new Error('Set VIBE_KANBAN_API_KEY in .env.gateway before enabling VIBE_KANBAN_MCP_LABEL.');
    servers.push({ label: tool.server_label, url: 'https://agentkanban.embeddedllm.com/mcp', allowed: tool.allowed_tools,
      headers: { Authorization: `Bearer ${key}` } });
  }
  if (!servers.length) return;
  if (new Set(servers.map(server => server.label)).size !== servers.length) throw new Error('Each MCP service needs a distinct label.');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'config.toml');
  let content = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const begin = '# BEGIN slack-agentic managed MCP';
  const end = '# END slack-agentic managed MCP';
  const start = content.indexOf(begin), finish = content.indexOf(end);
  if (start >= 0) {
    if (finish < start) throw new Error('Incomplete managed MCP configuration block.');
    content = content.slice(0, start) + content.slice(finish + end.length);
  }
  for (const server of servers) {
    if (new RegExp(`\\[mcp_servers\\.(?:"${server.label}"|${server.label})(?:\\]|\\.)`).test(content)) throw new Error(`MCP label ${server.label} already has a manual configuration. Choose another label.`);
  }
  const blocks = servers.map(server => [
    `[mcp_servers.${server.label}]`, `url = ${JSON.stringify(server.url)}`, `allowed_tools = ${JSON.stringify(server.allowed)}`,
    'require_approval = "never"',
    ...(server.headers ? ['headers = { ' + Object.entries(server.headers).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(', ') + ' }'] : []),
  ].join('\n'));
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content.trimEnd() + '\n\n' + begin + '\n' + blocks.join('\n\n') + '\n' + end + '\n', { mode: 0o600 });
  chmodSync(temp, 0o600); renameSync(temp, file);
}
