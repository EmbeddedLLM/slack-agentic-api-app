#!/usr/bin/env bash
set -euo pipefail
app_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_dir="$app_root/.runtime/agentic-api"
mkdir -p "$app_root/.runtime"
if [[ ! -d "$source_dir/.git" ]]; then
  git clone --branch main --depth 1 https://github.com/vllm-project/agentic-api.git "$source_dir"
else
  if [[ -n "$(git -C "$source_dir" status --porcelain)" ]] || [[ "$(git -C "$source_dir" branch --show-current)" != main ]]; then
    echo 'Gateway checkout must be clean and on main before updating.' >&2
    exit 1
  fi
  git -C "$source_dir" pull --ff-only origin main
fi
export XDG_CACHE_HOME="$app_root/.runtime/cache"
export ERYX_PRECOMPILE_INSTALL_ROOT="$app_root/.runtime/eryx-tools"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
cd "$source_dir"
./scripts/setup-eryx-runtime.sh
cargo build --release --locked -p agentic-server --bin agentic-server --features embedded-code-interpreter,file-search-pdf
git rev-parse HEAD > "$app_root/.runtime/gateway-source-commit"
echo "Gateway installed from main at $(cat "$app_root/.runtime/gateway-source-commit")"
echo "Binary: $source_dir/target/release/agentic-server"
