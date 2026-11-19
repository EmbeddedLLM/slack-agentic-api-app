# Host the Slack app

`npm start` and the Slack CLI start hook launch and supervise the Slack bridge and Agentic API together as two child processes. vLLM remains a separately managed model server. Slack Socket Mode uses outgoing connections, so the bot needs no public URL, reverse proxy or inbound port. Your browser-based documentation site is a separate static build.

## On the current machine

The checkout is `/home/akk/maral/res/slack-agentic-api-app`. The local configuration uses vLLM on `127.0.0.1:6767` and serves Agentic API on port `9002`. Fresh example files use ports 5050 and 9000; keep your existing private configuration when upgrading. The model observed during setup was `Qwen/Qwen3.8-27B-FP8`.

```bash
cd /home/akk/maral/res/slack-agentic-api-app
cp .env.example .env
cp access.example.json access.json
chmod 600 .env access.json
```

Edit `.env` with the Slack bot and app tokens. Keep:

```dotenv
AGENTIC_WS_URL=ws://127.0.0.1:9002/v1/responses
AGENTIC_MODEL=Qwen/Qwen3.8-27B-FP8
```

Edit `access.json` with real Slack member IDs. Use your You.com key in the gateway environment, not `.env` for the bot. Then:

```bash
npm start
# In another terminal, once the gateway is ready:
npm run smoke
```

If the existing gateway lacks interpreter or file-search features, use the [source gateway](./gateway). Build completion alone does not replace an already running process: stop the old gateway intentionally, then launch the new one on port 9000, or test on another port first.

## One tmux command with Slack CLI credentials

For the existing local app, the CLI injects Slack credentials:

```bash
cd /home/akk/maral/res/slack-agentic-api-app
/home/akk/.slack/bin/slack run \
  --app A0CKN50L1S4 --team T07TMD2H2P4 \
  --manifest-source remote --skip-update --no-color --no-activity
```

The start hook launches the source gateway on the configured port, waits for `/ready`, then starts the Slack bot. You should see `Gateway ready. Starting Slack bot…` followed by the bot's `started` log. Both processes stop with Ctrl+C. Detach from tmux with Ctrl+B, D to leave them running. Keep vLLM running separately.

`MANAGE_GATEWAY=true` is the default. `GATEWAY_STARTUP_TIMEOUT_MS=120000` controls how long startup waits for the gateway and model. The listener port must match `AGENTIC_WS_URL`. An occupied port fails startup instead of silently using or stopping another process. An unexpected child exit restarts the pair; interrupted requests are not replayed. Repeated failures stop after three restarts in a minute. An unexpected CLI exit shuts down its children rather than leaving a second bot connected.

To use an already running or remote gateway, set `MANAGE_GATEWAY=false`; the launcher waits for that gateway's `/ready` endpoint and starts only the bot. It never stops the external gateway. `npm run start:bot` is the advanced bot-only entry point, without readiness checks or supervision.

## Keep the bot running with a user service

The service generator uses this checkout and your current Node executable, including an NVM installation:

```bash
mkdir -p ~/.config/systemd/user
npm run --silent service:print > ~/.config/systemd/user/slack-agentic-bot.service
systemctl --user daemon-reload
systemctl --user enable --now slack-agentic-bot
journalctl --user -u slack-agentic-bot -f
```

The service reads `.env` and starts the gateway configured in `.env.gateway` together with the bot. It restarts the supervisor after failures. The supervisor also restarts both children if either exits unexpectedly, with at most three restarts per minute. Set `MANAGE_GATEWAY=false` only when another service owns your gateway. To keep user services running after logout or start them at boot, your administrator can enable lingering:

```bash
sudo loginctl enable-linger "$USER"
```

After editing configuration:

```bash
systemctl --user restart slack-agentic-bot
```

Policy edits in `access.json` take effect without a restart. Stop the bot with `systemctl --user stop slack-agentic-bot`.

## Optional document packages

Use `npm ci --ignore-scripts` to install the app, sticker renderer and documentation tools without downloading Chromium. PDF/Office extraction and PDF export use the optional packages:

```bash
npm ci --include=optional
```

PDF generation also requires working Chromium and its OS libraries. Verify that separately before depending on PDFs in production. The gateway's Python interpreter does not create or exchange PDF/plot artifacts.

## State and exposure

For temporary gateway storage, set `AGENTIC_API_HOME=/tmp/slack-agentic-api` and `TMPDIR=/tmp/slack-agentic-api/tmp` in `.env.gateway`, using directories owned by the gateway user with mode `0700`. Use a free `GATEWAY_PORT` and match it in the bot's `AGENTIC_WS_URL`. State under `/tmp` may be removed on reboot or by cleanup; use persistent storage when conversation and knowledge retention matters.

Keep `data/` and the gateway's database/files directory on persistent storage. Run one Slack bridge instance per installation: queues and pending plans are local to one process. If the gateway is on a different machine, use `wss://` and its configured bearer authentication; Socket Mode still needs no public endpoint for the bot.
