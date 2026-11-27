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
# Start the gateway and Slack bot together:
npm start
# Or use slack run when the CLI supplies Slack credentials.
```

The combined launcher reads `.env.gateway`, removes any `SLACK_*` environment variables from the gateway child, and starts the built binary. Search-provider secrets loaded from this file are not added to the bot process. It waits for gateway and model readiness before starting the bot. `npm run gateway:start` remains available for intentionally running only the gateway; set `MANAGE_GATEWAY=false` on the bot when using that separate mode. Defaults:

| Setting | Default |
|---|---|
| Upstream inference | `http://127.0.0.1:5050` |
| Gateway listener | `127.0.0.1:9000` |
| Search provider | `you` |
| Code interpreter | Enabled |
| Persistent state | `.runtime/gateway-data` |

Only one process can bind port 9000. Keep your existing gateway running during testing by setting a different `GATEWAY_PORT`; point the bot's `AGENTIC_WS_URL` at that port.

### Request timeouts

Two independent settings apply:

```dotenv
# .env — Slack client: total duration of one response
AGENTIC_TIMEOUT_MS=600000
# .env.gateway — gateway: wait for headers or the next upstream chunk
STREAMING_CHUNK_TIMEOUT_S=600
```

Both values represent 10 minutes, but the units differ. The gateway already defaults to 600 seconds and does not impose a total inference-round deadline while upstream data keeps arriving. A log saying `The gateway request timed out` is the Slack client reaching `AGENTIC_TIMEOUT_MS`. The gateway’s `--llm-ready-timeout-s` controls startup readiness, not inference. Restart the combined launcher after environment edits; Slack authentication stays intact. See the upstream [timeout configuration](https://github.com/vllm-project/agentic-api/blob/main/docs/guides/configuration.md#typed-upstream-timeouts).

### Change the model or its port

Slack authentication does not depend on your model server. Change `LLM_API_BASE` in `.env.gateway` to the new model-server address, and change `AGENTIC_MODEL` in the app's `.env` to the exact served model name. Restart your combined `npm start` or `slack run --app A_YOUR_APP_ID --team T_YOUR_TEAM_ID --no-activity` command; it restarts both the gateway and bot. No new Slack login or app creation is needed.

`AGENTIC_WS_URL` still points to Agentic API, not the model server. Change it only when moving the gateway itself. For example: Slack app → `ws://127.0.0.1:9001/v1/responses` → gateway → model server at `http://127.0.0.1:5050`.

The client follows the upstream [playground](https://github.com/vllm-project/agentic-api/tree/main/application_examples/agentic_playground): `response.create` for requests, `previous_response_id` for standard function continuations on the same socket, and live `response.inject` results for multi-agent function calls. Multi-agent mode requires stored responses. File search can request `file_search_call.results`; web citations do not require the optional `web_search_call.action.sources` expansion, which some upstream vLLM servers reject.

## Use your existing launch script

For an externally managed gateway, set `MANAGE_GATEWAY=false` in the bot environment. A script like `gateway-run.sh` can then continue to launch the gateway. Point it at the new binary and supply these variables in the gateway environment:

```bash
export AGENTIC_WEB_SEARCH_PROVIDER=you
export YOU_API_KEY='your-key'
export YOU_API_BASE_URL=https://ydc-index.io
export AGENTIC_CODE_INTERPRETER_ENABLED=true
```

Retain the existing `AGENTIC_API_HOME` if you need to continue its sessions and knowledge stores. The app wrapper deliberately uses separate state by default. Keep one `RUST_LOG` assignment: a later assignment replaces an earlier one.

You.com requires both the key and an explicit base URL: Agentic API does not supply a default endpoint for this provider. The example uses the endpoint in [You.com's Search API reference](https://you.com/docs/api-reference/search/v1-search).

## Interpreter requirements

Both the build feature and `AGENTIC_CODE_INTERPRETER_ENABLED=true` are required. The gateway verifies runtime readiness before accepting interpreter requests. It also needs a private temporary directory and Linux cgroup v2 delegation. A systemd user manager can provide automatic delegation; a production gateway service can use `Delegate=yes`.

Each Python call starts in a fresh sandbox. Include all needed code and small input datasets and use `print()` for results. Persistent variables, network access, package installs and file/artifact exchange are not exposed by this gateway integration. The Slack app's file-generation feature remains separate.

See the [upstream interpreter design and provisioning guide](https://github.com/vllm-project/agentic-api/blob/main/docs/design/embedded-code-interpreter.md). Default builds and old release binaries can lack these features even when the source checkout is current.
