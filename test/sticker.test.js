import test from 'node:test';
import assert from 'node:assert/strict';
import omggif from 'omggif';
import { renderSticker, validateSticker } from '../src/sticker.js';
const svg = x => `<svg width="256" height="256" viewBox="0 0 256 256"><circle cx="${x}" cy="128" r="30" fill="#00bbaa" stroke="white" stroke-width="4"/></svg>`;
const args = () => ({ filename: 'bouncing-dot.gif', frames: [80, 128, 176, 128].map(x => ({ svg: svg(x), duration_ms: 120 })) });

test('local renderer produces a small looping transparent GIF with different frames', async () => {
  const file = await renderSticker(args());
  assert.ok(file.buffer.length < 256 * 1024);
  const decoded = new omggif.GifReader(file.buffer);
  assert.equal(decoded.width, 256);
  assert.equal(decoded.height, 256);
  assert.equal(decoded.numFrames(), 4);
  assert.equal(decoded.loopCount(), 0);
  const first = Buffer.alloc(256 * 256 * 4), second = Buffer.alloc(first.length);
  decoded.decodeAndBlitFrameRGBA(0, first);
  decoded.decodeAndBlitFrameRGBA(1, second);
  assert.notDeepEqual(first, second);
  assert.equal(first[3], 0);
  assert.equal(decoded.frameInfo(0).delay, 12);
});

test('sticker validation rejects resources, code, oversized canvases and paths', () => {
  for (const content of [
    '<image href="file:///etc/passwd"/>', '<script>alert(1)</script>', '<use href="https://example.org/x"/>',
    '<rect style="fill:red"/>', '<path fill="url(#x)"/>', '<g onclick="alert(1)"/>',
    '<svg width="9000" height="9000"/>', '<foreignObject/>',
  ]) {
    const value = args(); value.frames[0].svg = svg(80).replace('</svg>', `${content}</svg>`);
    assert.throws(() => validateSticker(value));
  }
  const value = args(); value.frames[0].svg = '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + svg(80);
  assert.throws(() => validateSticker(value), /document types/);
  assert.throws(() => validateSticker({ ...args(), filename: '../leak.gif' }), /filename/);
  assert.throws(() => validateSticker({ ...args(), frames: Array(12).fill({ svg: svg(80), duration_ms: 500 }) }), /3 seconds/);
});

test('sticker rendering respects cancellation before launching a worker', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(renderSticker(args(), { signal: controller.signal }), /cancelled/);
});

test('attached raster image becomes a transparent animated sticker with its subject preserved', async () => {
  const { default: sharp } = await import('sharp');
  const fixture = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="white"/><circle cx="50" cy="50" r="25" fill="red"/></svg>');
  const png = await sharp(fixture).png().toBuffer();
  const request = { filename: 'photo-sticker.gif', prompt: 'Make this picture bounce', frames: null, source_image: { id: 'image_1', motion: 'bounce', background: 'solid' } };
  const file = await renderSticker(request, { sourceImages: { image_1: png } });
  const decoded = new omggif.GifReader(file.buffer);
  assert.equal(decoded.numFrames(), 12);
  assert.ok(file.buffer.length < 256*1024);
  const pixels = Buffer.alloc(256*256*4);
  decoded.decodeAndBlitFrameRGBA(0,pixels);
  const center=(128*256+128)*4;
  assert.ok(pixels[center]>200 && pixels[center+1]<60, 'original red subject remains');
  assert.equal(pixels[(55*256+55)*4+3],0, 'solid white image background was removed');
  await assert.rejects(renderSticker(request), /not attached/);
  await assert.rejects(renderSticker(request, { sourceImages: { image_1: fixture } }), /real PNG/);
  await assert.rejects(renderSticker({ ...request, source_image: { ...request.source_image, id: '/etc/passwd' } }), /attached image ID/);
});
