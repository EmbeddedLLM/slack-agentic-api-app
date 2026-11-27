import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureStickerArt, stickerArtTool } from '../src/sticker-art.js';

test('only a completed trusted MCP result grants access to a bounded local PNG', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sticker-art-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const id = 'art_' + 'a'.repeat(32), images = {};
  const png = Buffer.from([137,80,78,71,13,10,26,10]);
  writeFileSync(path.join(dir, id + '.png'), png);
  const event = { type: 'response.output_item.done', item: { type: 'mcp_call', server_label: 'sticker_art', name: 'sticker_art_status', status: 'completed', output: JSON.stringify({ ok: true, status: 'ready', image_id: id }) } };
  assert.equal(captureStickerArt(event, 'other_server', images, dir), false);
  assert.deepEqual(images, {});
  assert.equal(captureStickerArt({ ...event, item: { ...event.item, status: 'failed' } }, 'sticker_art', images, dir), false);
  assert.equal(captureStickerArt(event, 'sticker_art', images, dir), false, 'another request cannot claim a known artwork ID');
  captureStickerArt({ ...event, item: { ...event.item, name: 'generate_sticker_art', output: JSON.stringify({ ok: true, job_id: id.slice(4) }) } }, 'sticker_art', images, dir);
  assert.equal(captureStickerArt(event, 'sticker_art', images, dir), true);
  assert.deepEqual(images[id], png);
  const bad = { ...event, item: { ...event.item, output: JSON.stringify({ ok: true, status: 'ready', image_id: '../secret' }) } };
  assert.equal(captureStickerArt(bad, 'sticker_art', {}, dir), false);
  rmSync(path.join(dir, id + '.png')); symlinkSync('/etc/passwd', path.join(dir, id + '.png'));
  assert.equal(captureStickerArt(event, 'sticker_art', images, dir), false);
  assert.throws(() => stickerArtTool('bad.label'));
  assert.deepEqual(stickerArtTool('sticker_art').allowed_tools, ['generate_sticker_art', 'sticker_art_status']);
});
