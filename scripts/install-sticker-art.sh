#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v uv >/dev/null || { echo 'Install uv first: https://docs.astral.sh/uv/getting-started/installation/'; exit 1; }
export UV_CACHE_DIR="$PWD/.runtime/uv-cache"
export NUMBA_CACHE_DIR="$PWD/.runtime/numba-cache"
export U2NET_HOME="$PWD/.runtime/sticker-models"
export OMP_NUM_THREADS=4
export HF_HUB_DISABLE_IMPLICIT_TOKEN=1
export HF_XET_CACHE="$PWD/.runtime/hf-xet"
if [ ! -x .runtime/sticker-python/bin/python ]; then
  uv venv --python 3.12 .runtime/sticker-python
fi
uv pip install --python .runtime/sticker-python/bin/python 'rembg[cpu]==2.0.69'
.runtime/sticker-python/bin/python -c 'from rembg import new_session; new_session("isnet-general-use", providers=["CPUExecutionProvider"])'
if [ "${1:-}" != '--art' ]; then
  echo 'Subject cutouts ready. Use npm run sticker:install:art to install the CPU artwork server (~16 GB models).'
  exit 0
fi
if [ ! -d .runtime/ComfyUI/.git ]; then
  git clone https://github.com/Comfy-Org/ComfyUI.git .runtime/ComfyUI
  git -C .runtime/ComfyUI checkout 7c78b5641ab2d6cb7f7766a183a8a43a59de0a8b
fi
uv pip install --python .runtime/sticker-python/bin/python torch==2.15.0 torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .runtime/sticker-python/bin/python -r .runtime/ComfyUI/requirements.txt 'mcp==1.30.0' 'huggingface_hub[cli]'
.runtime/sticker-python/bin/hf download Comfy-Org/Flux-2-Klein-4B --revision 5b3abca5c0dc1ecd4eaf3340868d09063fc1c965 \
  split_files/diffusion_models/flux-2-klein-4b.safetensors \
  split_files/text_encoders/qwen_3_4b.safetensors \
  split_files/vae/flux2-vae.safetensors --local-dir .runtime/comfy-models --max-workers 3
.runtime/sticker-python/bin/python - <<'PY'
from pathlib import Path
root = Path.cwd() / '.runtime'
for group in ['diffusion_models', 'text_encoders', 'vae']:
    for source in (root / 'comfy-models/split_files' / group).glob('*.safetensors'):
        target = root / 'ComfyUI/models' / group / source.name
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            target.symlink_to(source)
print('CPU artwork server ready. Run npm run sticker:serve in tmux.')
PY
