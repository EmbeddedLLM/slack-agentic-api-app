import { parentPort, workerData } from 'node:worker_threads';
import { Resvg } from '@resvg/resvg-js';
import gifenc from 'gifenc';
import { imageFrames } from './sticker-image.js';
const { GIFEncoder, quantize, applyPalette } = gifenc;
try {
  const gif = GIFEncoder();
  let firstPixels, moved = false;
  const frames = workerData.sourceImage ? await imageFrames(workerData.sourceImage, workerData.source_image) : workerData.frames;
  for (const frame of frames) {
    // Model frames sometimes omit the namespace; validation already restricts
    // this document to our SVG-only element and attribute subset.
    const source = frame.svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<svg\b(?![^>]*\bxmlns\s*=)/, '<svg xmlns="http://www.w3.org/2000/svg"');
    const rendered = new Resvg(source, { font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } }).render();
    if (rendered.width !== 256 || rendered.height !== 256) throw new Error('Invalid sticker dimensions.');
    const rgba = rendered.pixels;
    if (!rgba.some((value, index) => index % 4 === 3 && value === 0)) throw new Error('Leave the background transparent rather than drawing a full-canvas background.');
    if (!firstPixels) firstPixels = Buffer.from(rgba);
    else if (!firstPixels.equals(rgba)) moved = true;
    const palette = quantize(rgba, 256, { format: 'rgba4444', oneBitAlpha: true });
    const indexed = applyPalette(rgba, palette, 'rgba4444');
    const transparentIndex = palette.findIndex(color => color[3] === 0);
    gif.writeFrame(indexed, 256, 256, { palette, delay: frame.duration_ms, repeat: 0, dispose: 2, transparent: transparentIndex >= 0, transparentIndex: Math.max(0, transparentIndex) });
  }
  if (!moved) throw new Error('The frames are identical. Draw visible motion between frames.');
  gif.finish();
  const bytes = gif.bytes();
  if (bytes.length > 256 * 1024) throw new Error('The sticker exceeds 256 KB. Simplify the artwork.');
  parentPort.postMessage({ bytes });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
