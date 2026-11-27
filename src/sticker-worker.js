import { parentPort, workerData } from 'node:worker_threads';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { imageFrames } from './sticker-image.js';
try {
  sharp.concurrency(2);
  const pixels = [];
  let firstPixels, moved = false;
  const frames = workerData.sourceImage ? await imageFrames(workerData.sourceImage, workerData.source_image) : workerData.frames;
  for (const frame of frames) {
    // Model frames sometimes omit the namespace; validation already restricts
    // this document to our SVG-only element and attribute subset.
    const source = frame.svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<svg\b(?![^>]*\bxmlns\s*=)/, '<svg xmlns="http://www.w3.org/2000/svg"');
    const rendered = new Resvg(source, { fitTo: { mode: 'zoom', value: 2 }, font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } }).render();
    if (rendered.width !== 512 || rendered.height !== 512) throw new Error('Invalid sticker dimensions.');
    const rgba = await sharp(rendered.pixels, { raw: { width: 512, height: 512, channels: 4 } }).resize(256, 256).raw().toBuffer();
    if (!rgba.some((value, index) => index % 4 === 3 && value === 0)) throw new Error('Leave the background transparent rather than drawing a full-canvas background.');
    if (!firstPixels) firstPixels = Buffer.from(rgba);
    else if (!firstPixels.equals(rgba)) moved = true;
    pixels.push(rgba);
  }
  if (!moved) throw new Error('The frames are identical. Draw visible motion between frames.');
  let bytes;
  // libvips/libimagequant supplies palette reuse, dithering and delta-frame
  // compression; lower palette sizes retain the fixed Slack attachment budget.
  for (const [colours, count] of [[256, frames.length], [128, frames.length], [128, 12], [96, 10], [64, 8]]) {
    // Downsample only the app's uniform image animation, preserving its loop
    // duration. Hand-drawn frames may have distinct timing and are never dropped.
    const length = workerData.sourceImage ? Math.min(count, frames.length) : frames.length;
    const selected = Array.from({ length }, (_, i) => Math.floor(i * frames.length / length));
    const delays = selected.map((index, i) => frames.slice(index, selected[i + 1] ?? frames.length).reduce((sum, frame) => sum + frame.duration_ms, 0));
    bytes = await sharp(Buffer.concat(selected.map(index => pixels[index])), { raw: { width: 256, height: 256 * length, channels: 4, pageHeight: 256 } })
      .gif({ loop: 0, delay: delays, colours, effort: 7,
        dither: 0.15, interFrameMaxError: 0, interPaletteMaxError: 3, keepDuplicateFrames: true }).toBuffer();
    if (bytes.length <= 256 * 1024) break;
  }
  if (bytes.length > 256 * 1024) throw new Error('The sticker exceeds 256 KB. Simplify the artwork.');
  parentPort.postMessage({ bytes });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
