import { Worker } from 'node:worker_threads';
import { SaxesParser } from 'saxes';

export const stickerTool = {
  type: 'function', name: 'create_sticker',
  description: 'Create and attach a small looping GIF sticker, at most 256 KB and 3 seconds. For an uploaded image, set source_image to its provided image ID, choose motion/background, and set frames=null; this preserves the actual image and adds a white outline. Background solid removes edge-connected plain background color, not complex scenes. Without an image, set source_image=null and draw 2–12 consistent SVG frames with visible motion, transparent background, white outer border and expressive shapes. Each SVG must use width="256" height="256" viewBox="0 0 256 256". Allowed: svg,g,path,circle,ellipse,rect,line,polyline,polygon,text,tspan. No scripts, styles, references or external resources. The first frame should be complete and the loop seamless.',
  strict: true,
  parameters: { type: 'object', additionalProperties: false, required: ['filename', 'prompt', 'source_image', 'frames'], properties: {
    filename: { type: 'string', description: 'Short filename ending in .gif, e.g. dancing-cat.gif.' },
    prompt: { type: 'string', description: 'The short requested sticker description and motion.' },
    source_image: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['id', 'motion', 'background'], properties: {
      id: { type: 'string', description: 'An image ID from this request, such as image_1. Never a URL or path.' },
      motion: { type: 'string', enum: ['bounce', 'wiggle', 'pulse', 'float', 'spin'] },
      background: { type: 'string', enum: ['keep', 'solid'], description: 'keep preserves existing alpha; solid removes edge-connected background matching a corner color. Use keep for complex photos.' },
    } }] },
    frames: { type: ['array', 'null'], minItems: 2, maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['svg', 'duration_ms'], properties: {
      svg: { type: 'string', description: 'A complete 256x256 SVG frame. Keep the subject consistent between frames.' },
      duration_ms: { type: 'integer', minimum: 60, maximum: 500 },
    } } },
  } },
};
const tags = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'text', 'tspan']);
const attrs = new Set(['xmlns', 'width', 'height', 'viewBox', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'fill-rule', 'clip-rule', 'opacity', 'fill-opacity', 'stroke-opacity', 'transform', 'font-size', 'font-weight', 'font-family', 'text-anchor', 'dominant-baseline', 'dx', 'dy']);

export function validateSticker(args) {
  if (!args || Object.keys(args).some(key => !['filename', 'frames', 'prompt', 'source_image'].includes(key)) || typeof args.filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.gif$/.test(args.filename)) throw new Error('Use a simple filename ending in .gif.');
  if (args.prompt !== undefined && (typeof args.prompt !== 'string' || args.prompt.length > 1000)) throw new Error('Keep the sticker description below 1000 characters.');
  if (args.source_image != null) {
    const source = args.source_image;
    if (typeof source !== 'object' || Object.keys(source).some(key => !['id', 'motion', 'background'].includes(key)) || !/^image_[1-9][0-9]*$/.test(source.id) || !['bounce', 'wiggle', 'pulse', 'float', 'spin'].includes(source.motion) || !['keep', 'solid'].includes(source.background)) throw new Error('Select an attached image ID, supported motion and background mode.');
    if (args.frames != null) throw new Error('Use frames=null when animating an attached image.');
    return args;
  }
  if (!Array.isArray(args.frames) || args.frames.length < 2 || args.frames.length > 12) throw new Error('Provide 2–12 animation frames.');
  if (args.frames.reduce((sum, frame) => sum + (frame?.duration_ms || 0), 0) > 3000) throw new Error('Keep the entire animation at most 3 seconds.');
  for (const frame of args.frames) {
    if (!frame || Object.keys(frame).some(key => !['svg', 'duration_ms'].includes(key)) || !Number.isInteger(frame.duration_ms) || frame.duration_ms < 60 || frame.duration_ms > 500) throw new Error('Frame duration must be 60–500 milliseconds.');
    if (typeof frame.svg !== 'string' || Buffer.byteLength(frame.svg) > 16000) throw new Error('Each SVG must be at most 16 KB.');
    const parser = new SaxesParser();
    let count = 0, depth = 0;
    parser.on('doctype', () => { throw new Error('SVG document types are not supported.'); });
    parser.on('processinginstruction', () => { throw new Error('SVG processing instructions are not supported.'); });
    parser.on('error', () => { throw new Error('Each frame must be valid SVG XML.'); });
    parser.on('opentag', node => {
      if (!tags.has(node.name) || ++count > 160 || ++depth > 16) throw new Error('Use simple SVG shapes, with at most 160 elements and 16 nesting levels.');
      if (count === 1) {
        if (node.name !== 'svg' || node.attributes.width !== '256' || node.attributes.height !== '256' || node.attributes.viewBox !== '0 0 256 256') throw new Error('Use an SVG root with width="256" height="256" viewBox="0 0 256 256".');
      } else if (node.name === 'svg') throw new Error('Nested SVG documents are not supported.');
      for (const [key, value] of Object.entries(node.attributes)) {
        if (!attrs.has(key)) throw new Error(`Unsupported SVG attribute: ${key}.`);
        if (key === 'xmlns') {
          if (value !== 'http://www.w3.org/2000/svg') throw new Error('Invalid SVG namespace.');
        } else if (!/^[\w\s.,#%()+-]*$/.test(value) || /url\s*\(/i.test(value)) throw new Error('SVG attributes must be plain values without resource references.');
      }
    });
    parser.on('closetag', () => { depth--; });
    parser.write(frame.svg).close();
    if (!count) throw new Error('An SVG frame is required.');
  }
  return args;
}

export async function renderSticker(args, { signal, sourceImages = {} } = {}) {
  validateSticker(args);
  const sourceImage = args.source_image ? sourceImages[args.source_image.id] : null;
  if (args.source_image) {
    if (!Buffer.isBuffer(sourceImage)) throw new Error('That image is not attached to this request. Attach the image again and use its provided ID.');
    if (sourceImage.length > 20 * 1024 * 1024) throw new Error('Use an image smaller than 20 MB.');
    const png = sourceImage.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = sourceImage[0] === 255 && sourceImage[1] === 216 && sourceImage[2] === 255;
    const gif = /^GIF8[79]a/.test(sourceImage.subarray(0, 6).toString('ascii'));
    const webp = sourceImage.subarray(0, 4).toString() === 'RIFF' && sourceImage.subarray(8, 12).toString() === 'WEBP';
    if (!png && !jpeg && !gif && !webp) throw new Error('Attach a real PNG, JPEG, GIF or WebP image. SVG and external references are not accepted.');
  }
  if (signal?.aborted) throw signal.reason;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sticker-worker.js', import.meta.url), { workerData: { ...args, sourceImage }, resourceLimits: { maxOldGenerationSizeMb: 128 }, execArgv: [] });
    let settled = false;
    const finish = (error, bytes) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error); else resolve({ filename: args.filename, buffer: Buffer.from(bytes) });
    };
    const abort = () => finish(signal.reason || new Error('Sticker rendering cancelled.'));
    const timer = setTimeout(() => finish(new Error('Sticker rendering timed out. Simplify the artwork.')), 15000);
    worker.on('message', result => result.error ? finish(new Error(result.error)) : finish(null, result.bytes));
    worker.on('error', () => finish(new Error('The local sticker renderer is unavailable. Check its native dependency installation.')));
    worker.on('exit', () => { if (!settled) finish(new Error('Sticker rendering stopped before completion.')); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
