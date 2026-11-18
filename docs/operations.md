# Operations

## Configuration

Copy `.env.example`; the gateway model ID and both Slack tokens must be supplied. Configure search credentials in the gateway process, not the bot. `AGENTIC_API_KEY` is the gateway bearer token; it is not a search key or Slack token. For OIDC, use a valid token and arrange renewal/restart outside this app; the bot does not refresh tokens automatically.

`AGENTIC_TOOLS` defaults to `web_search`. The trusted template enables `web_search,code_interpreter`. The interpreter must also be enabled on the gateway. Empty disables tools. Access-file role overrides take precedence, so remove those overrides if you want environment defaults. Unsupported tool names fail requests rather than executing local commands. Research requires both `deepResearch:true` and the `web_search` tool.

The access file is checked on each request, when queued work starts and on button actions. The default is deny. Guests are denied unless explicitly listed or `allowGuests:true`. A channel ceiling can lower an admin to member, for example:

```json
{"channels": {"C01234567": {"maxRole": "member"}}}
```

Merge that entry into the full access file. It is not a complete policy on its own.

`file_search` requires configured `vectorStoreIds` in the role or `AGENTIC_VECTOR_STORE_IDS`; see [files and knowledge](./files). `AGENTIC_MULTI_AGENT_ENABLED=true` allows `multi` for roles with `multiAgent:true`. `AGENTIC_MAX_CONCURRENT_SUBAGENTS=3` limits simultaneous children, not lifetime agent count or total tokens. `RESEARCH_MULTI_AGENT=true` enables delegation in authorized research. Resume rejects tools, vector stores or multi-agent permissions that have been revoked.

`AGENTIC_NATIVE_FILE_INPUTS=true` sends bounded extracted text as native `input_file` data. Set it to `false` to use inline prompt text instead. PDF and Office files still require local text extraction.

## Limits and optional features

- `MAX_CONCURRENT_JOBS=2`, `MAX_JOBS_PER_USER=2`: running and queued jobs count toward the user limit.
- `AGENTIC_TIMEOUT_MS=180000`: maximum duration of each gateway request, including connect time. Research uses several such requests.
- `RESEARCH_TIMEOUT_MS=3600000`: whole-run limit. Resume preserves completed sections. `RESEARCH_MAX_CONCURRENT=1` leaves capacity for chat.
- `AGENTIC_MAX_REQUEST_BYTES=10485760`: JSON frame limit, including base64 images; align with gateway limits.
- `AGENTIC_MAX_OUTPUT_TOKENS=8192`: completion limit, including provider reasoning where applicable. Incomplete responses are surfaced rather than saved as complete.
- `ATTACHMENT_CHAR_BUDGET=40000`: total extracted text in a request. Long documents are explicitly truncated.
- `MAX_INPUT_FILES`, `MAX_INPUT_FILE_BYTES`, `MAX_INPUT_IMAGES`, `MAX_FILES_PER_REPLY` and `MAX_FILE_BYTES` limit files.
- PDF/Office support requires optional npm packages. PDF also requires working Chromium and OS libraries; do not assume it is present after a minimal install.

## systemd

For the current checkout and an NVM Node installation, use the generated **user service** in the [hosting guide](./hosting). The system service below is an alternative for a dedicated production account.

Create a dedicated `slack-agentic` OS user, install the app under `/opt/slack-agentic-api-app`, and make that user the owner of its `data/` directory. Store `.env` with mode `0600`, readable by the service user. Change the Node path in `deploy/slack-agentic-bot.service` if needed, then install the unit:

```bash
sudo cp deploy/slack-agentic-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now slack-agentic-bot
sudo journalctl -u slack-agentic-bot -f
```

Run the gateway as a separate service. The bot opens outgoing Slack and gateway connections and needs no inbound listener. The systemd example assumes a minimal installation; verify Chromium sandbox support separately before enabling PDF export under service hardening.

## Persistence and recovery

Keep both the bot `data/` directory and the gateway database on persistent storage. The bot stores response pointers, research reports/checkpoints and one-time help hints. The gateway stores response history. Back them up according to your team's conversation-retention policy; local pointer deletion does not delete gateway history.

Research folders expire after `RESEARCH_KEEP_DAYS` (30 by default), measured by the thread folder's modification time. Pending plans are in memory and must be recreated after a restart. Jobs queued at restart are not replayed. After a failed research run, Resume repeats its interrupted section; completed sections are retained. A completed report remains on disk if Slack upload fails.

If the gateway has lost a stored response, the bot tells the user to start a new Slack thread. It does not silently replay old tool actions. Changing gateway URL, model or role permissions begins a new chat chain. Research checkpoints refuse a gateway/model change. To clear a user's chat memory administratively, stop the bot and remove the corresponding hashed pointer in `data/sessions/`, or clear all pointer files to reset everyone.

Use one bridge process per Slack installation. Job locks, duplicate-event suppression and pending plans are process-local; multiple replicas sharing Socket Mode are not supported by this version.

## Verification

`npm test` runs without external credentials and stubs the optional PDF renderer. `npm run smoke` sends one model request to your configured gateway over WebSocket. `scripts/gateway-integration.js` verifies the client against an actual Rust gateway using a deterministic upstream stub and a temporary database.

A real Slack workspace, your production model/search provider, PDF rendering and Office extraction still need deployment acceptance checks. The repository does not contain Slack credentials or start the bot automatically.
