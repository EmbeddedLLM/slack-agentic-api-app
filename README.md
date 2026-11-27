# Slack Agentic API App

A self-hosted Slack assistant built on [Agentic API](https://github.com/vllm-project/agentic-api), adapted from [EmbeddedLLM/slack-pi-agent-app](https://github.com/EmbeddedLLM/slack-pi-agent-app). All inference uses the native **WebSocket Responses API**.

## Capabilities

- Slack mentions, DMs, threaded memory, role permissions, job limits and cancellation.
- [Interactive polls and bookmarked Markdown documents](docs/polls-and-documents.md), using local function tools over the gateway WebSocket.
- [Microsoft Teams Calls for Slack](docs/teams-meetings.md): a ready-to-send call command in your thread using the official app’s sign-in. Optional direct Graph automation is also available.
- You.com web search through the gateway, with cited results.
- Optional [official GitHub MCP](docs/mcp.md) for public repository, issue and PR research.
- Optional [AgentKanban MCP](docs/mcp.md#agentkanban-board) for board columns, issues, assignments and comments.
- `multi <task>` for gateway subagents and multi-agent research.
- `steer <update>` for an active standard request, with successor tracking.
- Gateway Python code interpreter for calculations and analysis.
- Native text/image inputs, optional PDF/Office extraction, and role-scoped file search.
- Research plans, progress, saved sections, resume, and downloadable reports.
- [GIF stickers](docs/stickers.md) from prompts or images: optional local ComfyUI artwork, AI subject cutouts, white outlines and compact animation.
- A VitePress documentation website with local search and hosting instructions.

Steering currently supports single-agent chat only. Gateway Python returns text from fresh sandboxes; it cannot exchange files or create downloadable artifacts. Knowledge uploads/indexing use HTTP APIs; inference remains on WebSocket.

## Run locally

Requirements: Node.js 22.15+, Rust 1.98.1 for the gateway source build, a tool-capable model server, and a Slack app. Interpreter execution requires Linux cgroup v2 delegation; see [gateway setup](docs/gateway.md).

```bash
git clone https://github.com/EmbeddedLLM/slack-agentic-api-app.git
cd slack-agentic-api-app
npm ci
npm run gateway:install
cp deploy/gateway.env.example .env.gateway
cp .env.example .env
cp access.example.json access.json
chmod 600 .env .env.gateway access.json
```

`gateway:install` builds **Agentic API main from source**, including `embedded-code-interpreter` and `file-search-pdf`. Source and binary live under `.runtime/agentic-api`; the installed commit is recorded in `.runtime/gateway-source-commit`.

Set `YOU_API_KEY` in `.env.gateway`. Defaults match vLLM at `http://127.0.0.1:5050` and gateway port `9000`. `npm start` and `slack run` start the source gateway and bot together. If the port is already occupied, stop the separate gateway or set `MANAGE_GATEWAY=false` to use it as an external service.

Create the Slack app using [slack-app-manifest.json](slack-app-manifest.json); see [Slack setup](docs/slack-setup.md). Put the `xoxb-` bot token and `xapp-` app token in `.env`, set the exact served model ID, and add your Slack member ID to `access.json`. Unlisted users are denied.

```dotenv
AGENTIC_WS_URL=ws://127.0.0.1:9000/v1/responses
AGENTIC_MODEL=Qwen/Qwen3.8-27B-FP8
```

```bash
npm start
# In another terminal, once the gateway is ready:
npm run smoke
```

Slack Socket Mode needs **no public URL or inbound listener**. Keep the gateway private, or use `wss://` and gateway authentication for a remote connection.

## Hosting and documentation

- [Host the bot on this machine with systemd](docs/hosting.md)
- [Build and configure the source gateway](docs/gateway.md)
- [Multi-agent, steering and tools](docs/features.md)
- [Input files and searchable knowledge](docs/files.md)
- [Research and recovery](docs/research.md)
- [Create GIF stickers](docs/stickers.md)
- [Teams Calls and meeting options](docs/teams-meetings.md)
- [Configuration and operations](docs/operations.md)
- [Protocol and architecture](docs/architecture.md)

```bash
npm run docs:dev      # local documentation website
npm run docs:build    # static site in docs/.vitepress/dist
```

The manual GitHub Pages workflow is prepared for a later publication; a local build does not deploy it.

## Development

```bash
npm test
AGENTIC_SERVER_BIN=.runtime/agentic-api/target/release/agentic-server node scripts/gateway-integration.js
```

Tests cover WebSocket contracts and Slack handlers without live Slack credentials. The integration script uses a real source-built gateway with isolated storage and a deterministic model stub. Live model quality, You.com credentials, a Slack installation and Chromium rendering need deployment acceptance checks. See [development](docs/development.md).

## License

[Apache-2.0](LICENSE). Attribution and upstream source commits are recorded in [NOTICE](NOTICE).
