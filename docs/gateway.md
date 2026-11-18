# Source gateway and You.com

This app installs Agentic API from `main`, not a pinned PyPI package. The source checkout and compiled binary live in `.runtime/agentic-api`. The installer records its exact source SHA in `.runtime/gateway-source-commit` after a successful build.

## Build from main

```bash
npm run gateway:install
```

The installer uses a clean `main` checkout and fast-forward updates only. It stops if you have local source modifications or switched branches. It runs the upstream runtime setup script and:

```bash
cargo build --release --locked -p agentic-server --bin agentic-server \
  --features embedded-code-interpreter,file-search-pdf
```

`Cargo.lock` pins the dependencies. Eryx runtime assets stay under `.runtime/cache`; compilation uses up to four jobs by default. Set `CARGO_BUILD_JOBS` to change that limit.

## Start the app's gateway

```bash
cp deploy/gateway.env.example .env.gateway
# Edit .env.gateway to add YOU_API_KEY.
npm run gateway:start
```

The wrapper reads `.env.gateway`, removes any `SLACK_*` environment variables from the child process, and starts the built binary. Defaults:

| Setting | Default |
|---|---|
| Upstream inference | `http://127.0.0.1:5050` |
| Gateway listener | `127.0.0.1:9000` |
| Search provider | `you` |
| Code interpreter | Enabled |
| Persistent state | `.runtime/gateway-data` |

Only one process can bind port 9000. Keep your existing gateway running during testing by setting a different `GATEWAY_PORT`; point the bot's `AGENTIC_WS_URL` at that port.

## Use your existing launch script

A script like `gateway-run.sh` can continue to launch the gateway. Point it at the new binary and supply these variables in the gateway environment:

```bash
export AGENTIC_WEB_SEARCH_PROVIDER=you
export YOU_API_KEY='your-key'
export AGENTIC_CODE_INTERPRETER_ENABLED=true
```

Retain the existing `AGENTIC_API_HOME` if you need to continue its sessions and knowledge stores. The app wrapper deliberately uses separate state by default. Keep one `RUST_LOG` assignment: a later assignment replaces an earlier one.

## Interpreter requirements

Both the build feature and `AGENTIC_CODE_INTERPRETER_ENABLED=true` are required. The gateway verifies runtime readiness before accepting interpreter requests. It also needs a private temporary directory and Linux cgroup v2 delegation. A systemd user manager can provide automatic delegation; a production gateway service can use `Delegate=yes`.

Each Python call starts in a fresh sandbox. Include all needed code and small input datasets and use `print()` for results. Persistent variables, network access, package installs and file/artifact exchange are not exposed by this gateway integration. The Slack app's file-generation feature remains separate.

See the [upstream interpreter design and provisioning guide](https://github.com/vllm-project/agentic-api/blob/main/docs/design/embedded-code-interpreter.md). Default builds and old release binaries can lack these features even when the source checkout is current.
