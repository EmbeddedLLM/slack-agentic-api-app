# Quick start

The Slack bridge runs beside Agentic API. Your model server supplies inference; Agentic API owns tool execution and state; the bridge handles Slack access, files, and messages.

## 1. Install the app and source gateway

Use Node.js 22.15 or newer and the Rust toolchain required by Agentic API's `main` branch.

```bash
git clone https://github.com/EmbeddedLLM/slack-agentic-api-app.git
cd slack-agentic-api-app
npm ci --ignore-scripts
npm run gateway:install
```

The installer clones **main** into `.runtime/agentic-api`, prepares Eryx, and builds `embedded-code-interpreter` and `file-search-pdf`. `.runtime/` is ignored by Git. See [Source gateway](./gateway) for requirements.

## 2. Configure the gateway

```bash
cp deploy/gateway.env.example .env.gateway
chmod 600 .env.gateway
```

Add your `YOU_API_KEY` to `.env.gateway`. Set the vLLM upstream if it differs from `http://127.0.0.1:5050`. Start the gateway in a terminal:

```bash
```

The default endpoint is `ws://127.0.0.1:9000/v1/responses`. Use an unused port while another gateway is running. Interpreter startup requires a working systemd user manager and delegated Linux cgroup v2 controllers.

## 3. Configure Slack

Follow [Slack app setup](./slack-setup) to create a Socket Mode app, obtain its bot/app tokens, and invite it to your channels.

```bash
cp .env.example .env
cp access.example.json access.json
chmod 600 .env access.json
```

Set these in `.env`:

```dotenv
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_APP_TOKEN=xapp-your-token
AGENTIC_WS_URL=ws://127.0.0.1:9000/v1/responses
AGENTIC_MODEL=Qwen/Qwen3.8-27B-FP8
```

Use the exact model ID served by your vLLM. Replace the placeholder admin member ID in `access.json` with yours. The example admin can use web search, Python and multi-agent requests. File search is enabled separately after creating a knowledge base.

## 4. Verify and start

```bash
npm start
# In another terminal, once the gateway is ready:
npm run smoke
```

`npm start` starts the source gateway, waits for gateway/model readiness, then starts the bot. With CLI-injected Slack credentials, use `slack run` instead; it uses the same launcher. The smoke command sends one plain WebSocket inference request. Try `@bot help` in Slack, then `@bot multi compare these approaches` or a calculation. For a persistent service, continue to [Hosting](./hosting).
