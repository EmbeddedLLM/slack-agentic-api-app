# Slack setup

## Reuse an app created in Slack App Settings

An existing `bolt-support-agent` or other Bolt app can use this project's Agentic API backend. Keep the existing app ID and workspace. There is no need to create another app or configure an Anthropic/OpenAI provider for the template.

The project includes Slack CLI hooks and uses `index.js` as its entry point. After installing and authenticating the [Slack CLI](https://docs.slack.dev/tools/slack-cli/), link the app from this checkout:

```bash
cd /path/to/slack-agentic-api-app
slack app link --app A_YOUR_APP_ID --team T_YOUR_TEAM_ID --environment local
```

App IDs and workspace IDs are identifiers, not access tokens. For an App Settings app, set `manifest.source` to `remote` in `.slack/config.json` to keep App Settings as the source of truth. Inspect its current configuration and add the scopes and event subscriptions required by `slack-app-manifest.json`, while retaining the app's existing identity and AI settings. Reinstall after a scope change.

To apply changes through the CLI, save the existing manifest with your changes in the private `.slack/manifest.local.json`; the manifest hook uses it when present. Temporarily set `manifest.source` to `local`, run `slack manifest sync --manifest-source local --app A_YOUR_APP_ID --team T_YOUR_TEAM_ID`, then restore `remote` and restart `slack run` to reinstall. The CLI refuses manifest synchronization while the project source is `remote`. This project uses a manifest hook, so the CLI's warning about not writing a root `manifest.json` is expected; retain your merged private file.

Configure `AGENTIC_WS_URL` and `AGENTIC_MODEL` in `.env`, and add your Slack member ID as an admin in `access.json`. Then:

```bash
npm run smoke
slack run --app A_YOUR_APP_ID --team T_YOUR_TEAM_ID
```

The CLI provides the Slack bot and app tokens to the running process. Leave the token entries in `.env` empty for this workflow. For standalone `npm start` or systemd hosting, set the persistent `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` yourself in `.env`; never paste them into chat. Run only one bridge process for the app.

The CLI flow is for local development. The [hosting guide](./hosting) describes keeping the bot running as a service. Local app links and private configuration under `.slack/` are ignored by Git.

The start hook uses `exec node index.js` on Linux/macOS so CLI stop and reload signals reach the bot directly. A wrapper process can otherwise leave an old Socket Mode connection running and receiving events after a reload.

### App icon

The Meow-AI cat avatar is saved at `assets/meow-ai.png`. With Slack CLI 4.7 or newer, upload it when starting the app:

```bash
SLACK_CLI_APP_ICON_PATH=assets/meow-ai.png slack run --app A_YOUR_APP_ID --team T_YOUR_TEAM_ID --manifest-source remote
```

The CLI prints `Updated app icon` when Slack accepts the upload. Substitute your own square image path to use different branding. See Slack's [icon upload support](https://docs.slack.dev/changelog/2026/08/28/slack-cli/) and [icon path environment variable](https://docs.slack.dev/changelog/2026/05/19/slack-cli/).

## Create a new app or configure tokens manually

1. Open [Your Apps](https://api.slack.com/apps), choose **Create New App → From a manifest**, choose the workspace and paste `slack-app-manifest.json`.
2. In **Basic Information → App-Level Tokens**, generate a token with `connections:write`. Save it as `SLACK_APP_TOKEN`.
3. In **OAuth & Permissions**, install the app to the workspace. Save its bot token as `SLACK_BOT_TOKEN`.
4. Enable **Socket Mode**, **Interactivity**, and the Home tab if the manifest has not already done so. No public request URL is required.
5. Invite the bot to every channel it should read. Reinstall after changing OAuth scopes.
6. Copy your Slack member ID into `access.json` as an admin. The app's admin role is separate from Slack workspace administration.

The manifest subscribes to mentions, channel/private-channel/DM/group-DM messages, and Home tab events. By default, only mentions and direct messages trigger answers. `THREAD_FOLLOW=true` enables untagged messages in threads the bot has answered, subject to access checks.

Replies stay in the request's thread, including greetings, help, status messages, and access notices. A top-level request starts a thread; a reply in an existing thread stays there. Simple greetings such as `hi`, `hello`, and `hey`, or a bare mention, receive a short greeting. Ask `help` or `what can you do` to see the full capability guide.

The app uses `conversations.history` / `conversations.replies` for context, `users.info` for names and timezones, and authenticated Slack file downloads. [Slack's thread API documentation](https://docs.slack.dev/reference/methods/conversations.replies/) lists required history scopes. `npm run check-files -- F01234567` diagnoses file scopes for an existing file. `npm run users` lists member IDs; `npm run users -- --init` produces a starter access list (review it before adopting it: it grants members access).

Try these after startup:

- `@bot help` — role-specific guide.
- `@bot whoami` — your role and member ID.
- `@bot summarise this thread` — contextual reply.
- Attach a `.txt` file and ask `@bot summarise the attachment`.
- With deep-research access, `@bot research <question>` — edit the plan, then press **Start research**.

Cancellation is restricted to the requester or a role with `cancelAny`. Plan controls and research resume check current access. A pending plan expires after a day or a bot restart; completed research sections persist on disk.
