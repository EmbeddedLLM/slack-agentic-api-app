# Slack Agentic API App

A self-hosted Slack assistant powered by [Agentic API](https://github.com/vllm-project/agentic-api) and your model server. Adapted from [EmbeddedLLM/slack-pi-agent-app](https://github.com/EmbeddedLLM/slack-pi-agent-app).

**The bot uses the native WebSocket Responses API (`ws://` / `wss://…/v1/responses`).** It sends `response.create` frames, consumes response events, and continues conversations with `previous_response_id`. No Pi CLI or HTTP Responses fallback is used.

```mermaid
flowchart LR
  Slack[Slack Socket Mode] <--> Bot[Node.js Slack bridge]
  Bot <-->|WebSocket Responses| Gateway[Agentic API]
  Gateway <-->|Inference| Model[vLLM / model server]
  Gateway --> Search[Web search provider]
  Bot --> State[Response pointers and research checkpoints]
  Gateway --> Database[SQLite or PostgreSQL conversation state]
```

## Features

- Channel mentions, threaded replies, DMs, role-specific help and Home tab.
- Access roles (`none`, `viewer`, `member`, `admin`), channel ceilings, live policy reload, per-user job limits and cancellation.
- Persistent conversation memory, isolated by thread, user, permissions, gateway and model.
- Gateway-owned web search with cited output.
- Text and image attachments; optional PDF/Office extraction. Generated Markdown, CSV, JSON and optional PDF files.
- Research plans with edit/start buttons, progress, cancellation, saved sections, resume and report follow-ups.
- Slack credentials stay in the bridge. Known secret values and internal paths are scrubbed from Slack replies.

## Quick start

Requirements: Node.js 22.15+, an Agentic API gateway, a tool-capable model served behind it, and a Slack workspace where you can install an app.

### 1. Start Agentic API

For an existing vLLM server at `http://127.0.0.1:8000`:

```bash
uvx --from agentic-api==0.10.0 agentic serve --upstream http://127.0.0.1:8000
```

Configure the model's tool-call parser in vLLM. Use the exact served model ID in `AGENTIC_MODEL`. Enable a search provider on the **gateway**, for example:

```bash
AGENTIC_WEB_SEARCH_PROVIDER=brave BRAVE_API_KEY=your-search-key \
  uvx --from agentic-api==0.10.0 agentic serve --upstream http://127.0.0.1:8000
```

Gateway configuration and persistent storage are separate from the bot. Keep the gateway private or configure authentication and a TLS proxy for `wss://`. See the [upstream quickstart](https://github.com/vllm-project/agentic-api/blob/main/docs/guides/quickstart.md) and [web search configuration](https://github.com/vllm-project/agentic-api/blob/main/docs/guides/web-search.md).

### 2. Configure Slack and the bot

Create a Slack app from [slack-app-manifest.json](slack-app-manifest.json). Install it, copy the bot token (`xoxb-…`), and generate an app-level token (`xapp-…`) with `connections:write`. [Slack setup](docs/slack-setup.md) has the steps.

```bash
git clone https://github.com/EmbeddedLLM/slack-agentic-api-app.git
cd slack-agentic-api-app
npm ci --omit=optional
cp .env.example .env
cp access.example.json access.json
```

Edit `.env`:

```dotenv
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
AGENTIC_WS_URL=ws://127.0.0.1:9000/v1/responses
AGENTIC_MODEL=your-exact-served-model-id
# AGENTIC_API_KEY=your-gateway-bearer-token
```

Edit `access.json` with your Slack member ID as `admin` and teammates as `member`. Unlisted users are denied. The bot rereads the policy; an invalid or missing file denies access.

```bash
npm run smoke   # one WebSocket inference request; does not connect to Slack
npm start
```

Invite the bot into a channel and try `@bot help`, `@bot summarise this thread`, or `@bot research compare vector databases for our workload`.

### 3. Enable document features when needed

The minimal install supports text, image input and text-based output files. Install optional dependencies for PDF/Office extraction and PDF generation:

```bash
npm ci --include=optional
```

PDF export uses Chromium through `md-to-pdf` and needs its OS libraries and sandbox. `officeparser` extracts text from PDF, DOCX, PPTX, XLSX and OpenDocument files. Scanned PDFs need a text layer or separately supplied images. Images require a vision-capable model; text-only models cannot interpret them. A missing PDF renderer leaves the Markdown research report available and reports the PDF error.

## How it differs from the Pi app

| Area | This version |
|---|---|
| Agent runtime | Native Agentic API WebSocket client, no Pi subprocess |
| Memory | Stored response IDs; database history lives on the gateway |
| Tools | `web_search` is gateway-owned; no local `bash`, filesystem tools or package installation |
| Research | Approved plan → evidence sections → synthesis → summary; each completed response is checkpointed |
| Resume | Completed sections are retained; the interrupted section is repeated |
| Follow-ups | Use saved report and research notes, not a cached full-page archive |
| Research quality | Linked sources and stated limitations; no claim of independent fact checking |
| Long attachments | Bounded extracted text is inlined; truncation is disclosed, with no local `read` tool fallback |

The bridge currently exposes only `web_search`. MCP and code interpreter configuration on the gateway is not automatically exposed to Slack users.

## Operations and development

- [Configuration, deployment and state](docs/operations.md)
- [Protocol and implementation](docs/architecture.md)
- [Configuration template](.env.example) and [access template](access.example.json)
- [systemd service](deploy/slack-agentic-bot.service)

```bash
npm ci --omit=optional
npm test
```

Tests use recorded Slack method calls and a real local WebSocket test server. They cover protocol frames, authorization, cancellation, disconnects, thread memory, attachments, research checkpoints and resume. No Slack or model credentials are needed.

An optional integration check launches a real Rust gateway with isolated state and a deterministic model stub:

```bash
AGENTIC_SERVER_BIN=/path/to/agentic-server node scripts/gateway-integration.js
```

That check verifies streaming, same-socket continuation and durable continuation after reconnect. It does not test live model quality, search-provider credentials, Slack installation, or Chromium rendering.

## License and attribution

[Apache-2.0](LICENSE). The original Slack bridge and helpers are adapted from EmbeddedLLM's Slack Pi Agent. See [NOTICE](NOTICE) for source commits and the modifications made here.
