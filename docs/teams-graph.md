# Optional Microsoft Graph meeting automation

Ask in a channel or DM:

```text
@Meow-AI create a Teams meeting link for a 30-minute design review now
@Meow-AI create a Teams meeting for Friday, 15 January 2027 at 2pm Malaysia time, for one hour
```

The `create_teams_meeting` function creates a real meeting under **the requester’s own Microsoft work/school account** and returns its join link in the original Slack thread.

1. Ask Meow-AI to create a meeting with a date, time, timezone and duration (or say “now”).
2. If you have not connected Microsoft, or sign-in has expired, the bot sends a **private sign-in prompt**, visible only to you in that thread.
3. Open the Microsoft link, enter the short code, and sign in within five minutes. Do not send the code or your password to the bot.
4. The bot creates the pending meeting automatically and posts the confirmed join link in the same thread.

Later requests reuse your saved authorization. Each Slack member has separate credentials; nobody inherits another member’s account. Send `@Meow-AI teams disconnect` to remove your own saved sign-in. You can use the existing Cancel button while signing in; cancellation or failed sign-in creates no meeting.

Sign-in requires you to be active in Slack: ephemeral prompts disappear across sessions. A pending sign-in occupies a normal request slot for at most five minutes. If the bot restarts before sign-in finishes, request the meeting again. Microsoft tokens, passwords and sign-in codes never enter the model conversation.

This creates a **link-only meeting**. It does not add a calendar event, invite attendees, send email, or reserve calendars. Joining is subject to the organizer's Teams lobby and organization policies. Personal Microsoft accounts are unsupported by this Graph endpoint. Use an organizer enabled and licensed for Teams meetings.

This optional integration creates meeting links directly through Microsoft Graph. The default [official Slack app handoff](./teams-meetings) needs none of this Microsoft app registration.

## 1. Admin: register a Microsoft app once

This registration is separate from your Slack app. If you already have an appropriate Microsoft registration, open its Overview page instead of creating another.

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com) with your work/school account. Open **Entra ID → App registrations → New registration**. Your organization may require an administrator to do this.
2. Name it `Meow-AI Teams meetings`. Select **Accounts in this organizational directory only** and register. A redirect URI is not needed for device-code sign-in.
3. On **Overview**, copy **Application (client) ID** and **Directory (tenant) ID**. The client ID identifies this Microsoft app; the tenant ID identifies your Microsoft organization. Both are UUIDs, not secrets. A Slack client ID or workspace ID will not work.
4. Under **Authentication → Advanced settings**, enable **Allow public client flows**, then save. Portal layouts with separate settings tabs may show this setting there.
5. Under **API permissions → Add a permission → Microsoft Graph → Delegated permissions**, add **OnlineMeetings.ReadWrite**. Grant administrator consent if your organization requires it. Remove unused permissions from a new dedicated registration.

Use delegated permission, not the similarly named application permission. This integration signs in as each requesting member. It needs no client secret or application-access policy. See Microsoft's [public client configuration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration) and [createOrGet permissions](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-createorget?view=graph-rest-1.0).

## 2. Admin: enable sign-in from Slack

The app registration is required once for the installation. Members only perform the browser sign-in; they do not need to find tenant/client IDs or run terminal commands.

Put these settings in the app’s **`.env`**, using the IDs from Overview:

```dotenv
TEAMS_ENABLED=true
TEAMS_ORGANIZER_MODE=per_user
TEAMS_TENANT_ID=your-directory-tenant-uuid
TEAMS_CLIENT_ID=your-application-client-uuid
TEAMS_STATE_DIR=./data/teams
```

Restart your bot using its usual `npm start` or `slack run` command. No extra Slack scopes or Slack reauthentication are needed. The app uses Microsoft device-code login, so it needs no public callback URL or inbound HTTP listener.

```bash
npm run teams:status
```

In `per_user` mode, this checks app configuration without creating a meeting or signing in as anybody. Members then request meetings directly in Slack. Graph permissions, the organization’s device-code/consent policies and the requester’s Teams license are checked during sign-in/creation. Personal Microsoft accounts and accounts outside the configured Microsoft tenant are not supported.

Microsoft’s MSAL library refreshes saved tokens. If your organization requires a fresh sign-in, the next meeting request prompts you again.

### Already using Slack’s Microsoft Teams Calls app?

Members can use `/teams-calls` directly through that app. Its documented integration does not expose meeting creation to another bot or share its Microsoft OAuth credentials with Meow-AI. Use the same Microsoft account when authorizing Meow-AI, but grant this app its own permission once. See [Slack’s Teams Calls guide](https://slack.com/help/articles/360046159513-Microsoft-Teams-Calls-for-Slack).

### Optional shared organizer

The default mode is `slack_calls`, documented in [Microsoft Teams Calls](./teams-meetings). To deliberately use one organizer for everyone, set `TEAMS_ORGANIZER_MODE=shared`. Stop the bot, run `npm run teams:login`, sign in as that organizer, then restart. The terminal login/logout commands apply only to shared mode; per-user mode signs in and disconnects through Slack.

## Permissions and behavior

The tool is included in the gateway's WebSocket request when configured, enabled, and permitted for the requester. In per-user mode it is available before sign-in so it can guide the requester through connecting Microsoft. It executes locally against Microsoft Graph over HTTPS; inference and function-result continuation use the existing Agentic API WebSocket. Microsoft credentials never enter the gateway or model.

Members and admins have `createMeetings: true` by default. Viewers and bot peers cannot create meetings. Disable it for a role in `access.json`:

```json
{ "roles": { "member": { "createMeetings": false } } }
```

Merge that fragment into the existing policy. Permission edits apply to the next request and are checked again immediately before creation. Meeting permission is independent of file creation and poll/document permissions.

The tool accepts `subject`, `starts_at` (an explicit-offset ISO timestamp, or `null` for now), and `duration_minutes` (1–1440). The model receives the requester's Slack timezone and local time and should ask about an ambiguous schedule. The function validates dates, rejects past scheduled times, and converts timestamps to UTC.

One meeting is allowed per Slack request. Parallel subagent calls and retries reuse it, even if the model changes its arguments. Send separate requests for separate meetings; this tool does not edit meetings. Pending requests and confirmed results persist, and Graph's `createOrGet` uses a stable external ID to recover an uncertain result. A new Slack message is a new request and can create another meeting. If a network failure leaves the outcome unknown, check with the organizer before sending another creation request.

If the model fails after creation, the app preserves the confirmed join link in the thread. An invented or unverified link is never used as proof of creation.

## Stored state and troubleshooting

`TEAMS_STATE_DIR` defaults to `data/teams`, ignored by Git. Keep it persistent across restarts and upgrades. In per-user mode each member has a separate `users/<workspace-and-user-hash>/` directory. Shared mode uses the state directory directly. Each account directory contains:

- `organizer.json`: selected Microsoft account identity.
- `cache.json`: MSAL token cache encrypted with AES-256-GCM.
- `cache.key`: local encryption key.
- `meetings/`: pending requests and confirmed links for duplicate protection.

The directory is private (`0700`); credential and meeting files are private (`0600`). The key is on the same host, so the bot's OS user can decrypt the cache. Protect backups as credentials; encryption does not protect against compromise of that user. Do not put this state in gateway home, expose it through file search, or commit it.

- **Tool missing:** check `TEAMS_ENABLED`, both Microsoft IDs, `npm run teams:status`, and `createMeetings` permission. Incomplete setup leaves the tool disabled.
- **Sign-in expired:** request a meeting again and complete the new private prompt. Shared mode instead needs the admin to run `npm run teams:login`. Slack authentication is unaffected.
- **Creation denied (403):** check delegated consent, organizer Teams license, and organization policies.
- **Rate limit (429):** wait before trying again. New Slack messages have new meeting IDs.
- **Corrupt cache:** send `@Meow-AI teams disconnect`, then request a meeting again. For shared mode, stop the bot and run `npm run teams:logout` followed by `npm run teams:login`. Meeting records remain.

`teams disconnect` removes only the requesting member’s local credentials. In shared mode, `npm run teams:logout` removes the shared organizer credentials. It does not delete meetings or revoke consent in Microsoft. Revoke Microsoft consent separately if retiring the integration.
