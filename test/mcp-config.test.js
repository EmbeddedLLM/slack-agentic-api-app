import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { configureMcp } from '../src/mcp-config.js';
import { githubMcpTool, progressFromEvent } from '../src/mcp-tools.js';

test('MCP registration preserves existing gateway settings, rotates secrets privately, and restricts tool declarations', t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mcp-config-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'config.toml');
  writeFileSync(file, '[web_search]\nprovider = "you"\n');
  const env = { STICKER_MCP_LABEL: 'sticker_art', GITHUB_MCP_LABEL: 'github_public', GITHUB_MCP_TOKEN: 'fake-token-one' };
  configureMcp(home, env);
  configureMcp(home, { ...env, GITHUB_MCP_TOKEN: 'fake-token-two' });
  const text = readFileSync(file, 'utf8');
  assert.match(text, /provider = "you"/);
  assert.equal((text.match(/\[mcp_servers.github_public\]/g) || []).length, 1);
  assert.ok(!text.includes('fake-token-one'));
  assert.match(text, /Bearer fake-token-two/);
  assert.match(text, /"X-MCP-Readonly" = "true"/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const tool = githubMcpTool('github_public');
  assert.equal(tool.server_url, undefined);
  assert.equal(tool.headers, undefined);
  assert.ok(tool.allowed_tools.includes('pull_request_read'));
  assert.ok(!tool.allowed_tools.includes('create_pull_request'));
  assert.throws(() => configureMcp(home, { GITHUB_MCP_LABEL: 'github_public' }), /GITHUB_MCP_TOKEN/);
  assert.throws(() => configureMcp(home, { ...env, GITHUB_MCP_LABEL: 'sticker_art' }), /distinct/);
  writeFileSync(file, '[mcp_servers.sticker_art]\nurl="http://example.test/mcp"\n');
  assert.throws(() => configureMcp(home, { STICKER_MCP_LABEL: 'sticker_art' }), /manual configuration/);
});

test('progress distinguishes document arguments, text output and MCP work without exposing content', () => {
  const state = {};
  assert.match(progressFromEvent({ type: 'response.output_item.added', item: { id: 'call1', type: 'function_call', name: 'save_channel_document' } }, state), /Drafting/);
  assert.equal(progressFromEvent({ type: 'response.function_call_arguments.delta', item_id: 'call1', delta: 'private draft' }, state), 'Drafting the Markdown document · 13 characters');
  assert.equal(progressFromEvent({ type: 'response.output_text.delta', delta: 'hello' }, state), 'Writing the answer · 5 characters');
  assert.equal(progressFromEvent({ type: 'response.output_item.added', item: { type: 'mcp_call', name: 'sticker_art_status' } }, state), 'Waiting for sticker artwork');
});
