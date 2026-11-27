# Microsoft Teams Calls for Slack

Meow-AI uses the [official Microsoft Teams Calls app for Slack](https://slack.com/help/articles/360046159513-Microsoft-Teams-Calls-for-Slack). This route needs **no Microsoft tenant ID, client ID, or custom OAuth registration** in Meow-AI.

## Connect Microsoft in Slack

If the official app is already installed, open **Slack → Apps → Microsoft Teams Calls → Home → Connect**, then sign in to Microsoft. If you already connected your account there, keep using that connection. If the app is missing, an authorized workspace member can install it through the Marketplace link in Slack’s guide.

Meow-AI does not read or copy that app’s credentials. Each person’s Microsoft connection remains managed by the official app.

## Ask Meow-AI for a call

```text
@Meow-AI help me start a Teams call for a design review
```

Meow-AI replies **in your thread** with a command such as:

```text
/teams-calls meeting [Design review]
```

Copy and send that command yourself in the **main channel or DM composer**, outside the thread. The official Teams app then posts its join prompt in that conversation. Copy the resulting meeting link into the original thread if you want it there.

Slack’s documented integration is initiated by the user’s slash command. It does not expose a meeting-creation API for Meow-AI to call, and posting a command as bot text does not execute it. Developer-created slash commands are not available inside message threads. See [Slack’s command documentation](https://docs.slack.dev/interactivity/implementing-slash-commands).

The local `create_teams_meeting` function prepares this handoff. Its result explicitly reports `created: false`, `scheduled: false`, `requires_user_action: true`, and no join URL. Meow-AI displays the handoff instructions even if the model mistakenly says the meeting is ready.

## Dates, duration and invitations

The documented `/teams-calls meeting [subject]` command starts a call when you send it. It has no documented date/time or duration arguments and does not schedule a future calendar meeting. Schedule future meetings in Teams or Outlook and share the link back in Slack.

Automatic creation for a specified date/time, with Meow-AI returning the verified join link in the thread, requires the separate [optional Microsoft Graph integration](./teams-graph). That is the mode requiring a Microsoft app registration.

## App settings

```dotenv
TEAMS_ENABLED=true
TEAMS_ORGANIZER_MODE=slack_calls
```

Restart the app after changing `.env`. The default organizer mode is `slack_calls`; `per_user` and `shared` explicitly select the optional Graph integration. Existing Microsoft cache files are left in place but are not used by the official-app mode.

Human members and admins can request the handoff with `createMeetings: true`. Viewers and bot peers do not receive the tool. This role controls Meow-AI’s helper; access to the official app itself is governed by Slack and Microsoft.

```bash
npm run teams:login   # prints the official app’s Connect instructions
npm run teams:status  # checks Meow-AI’s handoff configuration only
npm run teams:logout # prints the official app’s logout command
```

These terminal commands do not sign in, create a meeting, or disconnect the official app. To disconnect, send `/teams-calls logout` in the main composer and confirm in Slack. `@Meow-AI teams disconnect` explains that same step.
