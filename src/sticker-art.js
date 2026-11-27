import { openSync, readFileSync, closeSync, fstatSync, constants } from 'node:fs';
import path from 'node:path';
const requestedJobs = new WeakMap();

export function stickerArtTool(label) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(label)) throw new Error('STICKER_MCP_LABEL must be a configured gateway MCP label.');
  return { type: 'mcp', server_label: label, allowed_tools: ['generate_sticker_art', 'sticker_art_status'], require_approval: 'never' };
}

// Only accept artifacts announced by our trusted server in this request.
// A model-supplied ID alone never grants access to a file on disk.
export function captureStickerArt(event, label, images, directory = path.resolve('.runtime/sticker-art')) {
  if (event.type !== 'response.output_item.done' || !label) return false;
  const item = event.item;
  if (item?.type !== 'mcp_call' || item.server_label !== label || item.status !== 'completed') return false;
  let fd;
  try {
    const result = JSON.parse(item.output);
    if (item.name === 'generate_sticker_art' && result.ok === true && /^[a-f0-9]{32}$/.test(result.job_id)) {
      if (!requestedJobs.has(images)) requestedJobs.set(images, new Set());
      requestedJobs.get(images).add(result.job_id);
      return false;
    }
    if (item.name !== 'sticker_art_status') return false;
    if (result.ok !== true || result.status !== 'ready' || !/^art_[a-f0-9]{32}$/.test(result.image_id)) return false;
    if (!requestedJobs.get(images)?.has(result.image_id.slice(4))) return false;
    fd = openSync(path.join(directory, result.image_id + '.png'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return false;
    const bytes = readFileSync(fd);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
    images[result.image_id] = bytes;
    return true;
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export const stickerArtInstructions = 'For new sticker artwork, use generate_sticker_art with a short visual description, then sticker_art_status with the returned job_id until ready. Do not submit duplicate jobs. Then call create_sticker with the returned image_id, background=auto, requested motion, and frames=null. For an attached image, call create_sticker directly with its image ID and background=auto to preserve the subject. Animation moves the cutout; it does not generate new poses. Only fall back to simple SVG artwork if the artwork service fails, and explain the fallback.';
