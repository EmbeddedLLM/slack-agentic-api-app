import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export function cutoutSettings(env = process.env) {
  const python = env.STICKER_PYTHON || path.join(root, '.runtime/sticker-python/bin/python');
  const models = env.STICKER_MODELS_DIR || path.join(root, '.runtime/sticker-models');
  return { python, models, ready: existsSync(python) && existsSync(path.join(models, 'isnet-general-use.onnx')) };
}

export async function cutoutImage(bytes, { signal, settings = cutoutSettings() } = {}) {
  if (!settings.ready) throw new Error('Automatic subject cutouts need npm run sticker:install. Use background=keep for a transparent image or solid for a plain background.');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(settings.python, [path.join(root, 'scripts/sticker-cutout.py')], {
      // No Slack or gateway credentials enter the segmentation subprocess.
      env: { PATH: process.env.PATH || '/usr/bin:/bin', U2NET_HOME: settings.models,
        NUMBA_CACHE_DIR: path.join(root, '.runtime/numba-cache'), OMP_NUM_THREADS: '4', CUDA_VISIBLE_DEVICES: '' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let done = false, size = 0; const parts = [];
    const finish = (error, data) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      child.kill('SIGKILL');
      if (error) reject(error); else resolve(data);
    };
    const abort = () => finish(signal.reason || new Error('Sticker cutout cancelled.'));
    const timer = setTimeout(() => finish(new Error('Subject cutout timed out. Try a smaller image.')), 90000);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) finish(new Error('Cutout image exceeds the size limit.'));
      else parts.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new Error('The local cutout interpreter could not start. Run npm run sticker:install.')));
    child.on('close', code => code === 0 && size > 0 ? finish(null, Buffer.concat(parts)) : finish(new Error('Subject cutout failed. Try a transparent image or background=solid.')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else child.stdin.end(bytes);
  });
}
