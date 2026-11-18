# Host the Slack app

Run the Slack bridge and Agentic API as separate processes. Slack Socket Mode uses outgoing connections, so the bot needs no public URL, reverse proxy or inbound port. Your browser-based documentation site is a separate static build.

## On the current machine

The checkout is `/home/akk/maral/res/slack-agentic-api-app`. The existing gateway launch uses vLLM on `127.0.0.1:5050` and serves Agentic API on port `9000`. The model observed during setup was `Qwen/Qwen3.8-27B-FP8`.

```bash
cd /home/akk/maral/res/slack-agentic-api-app
cp .env.example .env
cp access.example.json access.json
chmod 600 .env access.json
```

Edit `.env` with the Slack bot and app tokens. Keep:

```dotenv
AGENTIC_WS_URL=ws://127.0.0.1:9000/v1/responses
AGENTIC_MODEL=Qwen/Qwen3.8-27B-FP8
```

Edit `access.json` with real Slack member IDs. Use your You.com key in the gateway environment, not `.env` for the bot. Then:

```bash
npm run smoke
npm start
```

If the existing gateway lacks interpreter or file-search features, use the [source gateway](./gateway). Build completion alone does not replace an already running process: stop the old gateway intentionally, then launch the new one on port 9000, or test on another port first.

## Keep the bot running with a user service

The service generator uses this checkout and your current Node executable, including an NVM installation:

```bash
mkdir -p ~/.config/systemd/user
npm run --silent service:print > ~/.config/systemd/user/slack-agentic-bot.service
systemctl --user daemon-reload
systemctl --user enable --now slack-agentic-bot
journalctl --user -u slack-agentic-bot -f
```

The service reads `.env` from its working directory. It restarts after crashes. It does not start or replace the gateway. To keep user services running after logout or start them at boot, your administrator can enable lingering:

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

Keep `data/` and the gateway's database/files directory on persistent storage. Run one Slack bridge instance per installation: queues and pending plans are local to one process. If the gateway is on a different machine, use `wss://` and its configured bearer authentication; Socket Mode still needs no public endpoint for the bot.
