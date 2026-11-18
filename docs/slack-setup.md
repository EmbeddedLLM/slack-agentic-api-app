# Slack setup

## Reuse an app created in Slack App Settings

An existing `bolt-support-agent` or other Bolt app can use this project's Agentic API backend. Keep the existing app ID and workspace. There is no need to create another app or configure an Anthropic/OpenAI provider for the template.

The project includes Slack CLI hooks and uses `index.js` as its entry point. After installing and authenticating the [Slack CLI](https://docs.slack.dev/tools/slack-cli/), link the app from this checkout:

```bash
cd /path/to/slack-agentic-api-app
slack app link --app A_YOUR_APP_ID --team T_YOUR_TEAM_ID --environment local
```

App IDs and workspace IDs are identifiers, not access tokens. Linking an App Settings app keeps its remote manifest as the source of truth. Inspect its current configuration and add the scopes and event subscriptions required by `slack-app-manifest.json`, while retaining the app's existing identity and AI settings. Reinstall if Slack requests it after a scope change.

Configure `AGENTIC_WS_URL` and `AGENTIC_MODEL` in `.env`, and add your Slack member ID as an admin in `access.json`. Then:

```bash
npm run smoke
slack run --app A_YOUR_APP_ID --team T_YOUR_TEAM_ID
```

The CLI provides the Slack bot and app tokens to the running process. Leave the token entries in `.env` empty for this workflow. For standalone `npm start` or systemd hosting, set the persistent `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` yourself in `.env`; never paste them into chat. Run only one bridge process for the app.

The CLI flow is for local development. The [hosting guide](./hosting) describes keeping the bot running as a service. Local app links and private configuration under `.slack/` are ignored by Git.

## Create a new app or configure tokens manually

1. Open [Your Apps](https://api.slack.com/apps), choose **Create New App → From a manifest**, choose the workspace and paste `slack-app-manifest.json`.
2. In **Basic Information → App-Level Tokens**, generate a token with `connections:write`. Save it as `SLACK_APP_TOKEN`.
3. In **OAuth & Permissions**, install the app to the workspace. Save its bot token as `SLACK_BOT_TOKEN`.
4. Enable **Socket Mode**, **Interactivity**, and the Home tab if the manifest has not already done so. No public request URL is required.
5. Invite the bot to every channel it should read. Reinstall after changing OAuth scopes.
6. Copy your Slack member ID into `access.json` as an admin. The app's admin role is separate from Slack workspace administration.

The manifest subscribes to mentions, channel/private-channel/DM/group-DM messages, and Home tab events. By default, only mentions and direct messages trigger answers. `THREAD_FOLLOW=true` enables untagged messages in threads the bot has answered, subject to access checks.

The app uses `conversations.history` / `conversations.replies` for context, `users.info` for names and timezones, and authenticated Slack file downloads. [Slack's thread API documentation](https://docs.slack.dev/reference/methods/conversations.replies/) lists required history scopes. `npm run check-files -- F01234567` diagnoses file scopes for an existing file. `npm run users` lists member IDs; `npm run users -- --init` produces a starter access list (review it before adopting it: it grants members access).

Try these after startup:

- `@bot help` — role-specific guide.
- `@bot whoami` — your role and member ID.
- `@bot summarise this thread` — contextual reply.
- Attach a `.txt` file and ask `@bot summarise the attachment`.
- As an admin, `@bot research <question>` — edit the plan, then press **Start research**.

Cancellation is restricted to the requester or a role with `cancelAny`. Plan controls and research resume check current access. A pending plan expires after a day or a bot restart; completed research sections persist on disk.
