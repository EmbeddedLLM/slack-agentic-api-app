# Teams meetings and invitations

Meow-AI can create a Teams call, invite people, and return the confirmed join link in your Slack thread:

```text
@Meow-AI create a Teams call now for 30 minutes and invite @Alice and bob@example.com
@Meow-AI create a design review on 15 January 2027 at 2pm Malaysia time, for one hour, and invite @Alice
```

Select actual people when typing Slack @mentions, or supply their email addresses. The bot resolves mentioned members’ profile emails and asks for an address if one is unavailable. It does not guess addresses from names. Include the complete invitee list in the current message.

The bot sends you a private Microsoft sign-in prompt when needed. Complete it in your browser; the bot then creates the meeting and submits calendar invitations through Microsoft. The confirmed join link and invitation recipients appear in the original thread. Later requests reuse your saved sign-in. No `/teams-calls` command is required in this mode.

**An administrator must complete the one-time [Microsoft Graph setup](./teams-graph) first.** It needs a Microsoft app’s tenant ID and client ID, public client flows, and delegated `OnlineMeetings.ReadWrite` and `Calendars.ReadWrite` permissions. These IDs belong to Microsoft, not your Slack app. Each member then uses their own work/school Microsoft account as organizer.

Resolving Slack mentions also requires the `users:read.email` scope and reinstalling the Slack app to grant that scope. Explicit email addresses work without it.

```dotenv
TEAMS_ENABLED=true
TEAMS_ORGANIZER_MODE=per_user
TEAMS_TENANT_ID=your-directory-tenant-uuid
TEAMS_CLIENT_ID=your-application-client-uuid
```

Restart after changing `.env`. See the [full setup and troubleshooting guide](./teams-graph) for sign-in, permissions, duplicate handling and the optional shared-organizer mode. Requests with no invitees create a link-only meeting without a calendar event. Invitations do not confirm attendance or inbox delivery.

## If your workspace already uses Microsoft Teams Calls

The [official Microsoft Teams Calls app for Slack](https://slack.com/help/articles/360046159513-Microsoft-Teams-Calls-for-Slack) keeps its own Microsoft connection. Meow-AI cannot reuse that app’s credentials or execute its slash command. A bot posting `/teams-calls` as text does not run it; Slack’s documented integration is started by a person.

If you prefer to use the official app manually, explicitly choose:

```dotenv
TEAMS_ENABLED=true
TEAMS_ORGANIZER_MODE=slack_calls
```

That mode needs no Microsoft app registration in Meow-AI. Open **Slack → Apps → Microsoft Teams Calls → Home → Connect** and sign in there. Ask Meow-AI to help start a call; it returns a command such as:

```text
/teams-calls meeting [Design review]
```

You must send it yourself in the **main channel or DM composer**, outside the thread. The official app posts its join prompt there; copy the link back to the thread if needed. This route cannot schedule the requested date/time or send calendar invitations. Meow-AI reports that no meeting was created by its helper.

In `slack_calls` mode, `npm run teams:login`, `teams:status` and `teams:logout` print guidance for the official app. They do not log in or execute its commands. Send `/teams-calls logout` yourself to disconnect it. In automatic mode, send `@Meow-AI teams disconnect` to remove your own Microsoft sign-in from Meow-AI.
