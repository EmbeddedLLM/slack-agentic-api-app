"""Run the CPU ComfyUI + MCP services together (no Slack credentials needed)."""
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parent.parent
python = root / '.runtime/sticker-python/bin/python'
comfy_port = int(os.environ.get('STICKER_COMFY_PORT', '8188'))
mcp_port = int(os.environ.get('STICKER_MCP_PORT', '8189'))
env = {k: v for k, v in os.environ.items() if k in ['PATH', 'HOME', 'LANG', 'TMPDIR', 'STICKER_ART_DIR', 'STICKER_COMFY_WORKFLOW']}
env.update(CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='16', MKL_NUM_THREADS='16',
           STICKER_COMFY_URL=f'http://127.0.0.1:{comfy_port}', STICKER_MCP_PORT=str(mcp_port))
children = []
stopping = False

def stop(*_):
    global stopping
    stopping = True

for sig in [signal.SIGINT, signal.SIGTERM, signal.SIGHUP]:
    signal.signal(sig, stop)

try:
    for port in [comfy_port, mcp_port]:
        with socket.socket() as sock:
            if sock.connect_ex(('127.0.0.1', port)) == 0:
                raise RuntimeError(f'Port {port} is already in use; do not start a duplicate service.')
    if not python.is_file():
        raise RuntimeError('Run npm run sticker:install:art first.')
    command = [str(python), str(root / '.runtime/ComfyUI/main.py'), '--cpu', '--listen', '127.0.0.1', '--port', str(comfy_port),
               '--fp32-unet', '--fp32-text-enc', '--fp32-vae', '--disable-all-custom-nodes', '--disable-partner-nodes', '--disable-auto-launch', '--disable-metadata']
    children.append(subprocess.Popen(command, cwd=root, env=env))
    deadline = time.monotonic() + 180
    while not stopping:
        if children[0].poll() is not None or time.monotonic() > deadline:
            raise RuntimeError('ComfyUI did not become ready.')
        try:
            with urllib.request.urlopen(env['STICKER_COMFY_URL'] + '/system_stats', timeout=2) as response:
                if response.status == 200:
                    break
        except Exception:
            time.sleep(1)
    if not stopping:
        children.append(subprocess.Popen([str(python), str(root / 'scripts/sticker-art-mcp.py')], cwd=root, env=env))
        print(f'Sticker MCP: http://127.0.0.1:{mcp_port}/mcp · ComfyUI: {env["STICKER_COMFY_URL"]}', flush=True)
    while not stopping:
        if any(child.poll() is not None for child in children):
            raise RuntimeError('A sticker service exited. Check the log before restarting.')
        time.sleep(1)
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exitcode = 1
finally:
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
    for child in children:
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait()
    sys.exit(getattr(sys, 'exitcode', 0))
