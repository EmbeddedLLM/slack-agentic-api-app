# Microsoft Teams meeting links

Ask in a channel or DM:

```text
@Meow-AI create a Teams meeting link for a 30-minute design review now
@Meow-AI create a Teams meeting for Friday, 15 January 2027 at 2pm Malaysia time, for one hour
```

The `create_teams_meeting` function creates a real join link under **one shared work/school organizer account** and returns it in the request's Slack thread. Everyone with meeting permission uses that organizer; Slack members do not each sign in to Microsoft.

This creates a **link-only meeting**. It does not add a calendar event, invite attendees, send email, or reserve calendars. Joining is subject to the organizer's Teams lobby and organization policies. Personal Microsoft accounts are unsupported by this Graph endpoint. Use an organizer enabled and licensed for Teams meetings.

## 1. Register a Microsoft app

This registration is separate from your Slack app. If you already have an appropriate Microsoft registration, open its Overview page instead of creating another.

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com) with your work/school account. Open **Entra ID → App registrations → New registration**. Your organization may require an administrator to do this.
2. Name it `Meow-AI Teams meetings`. Select **Accounts in this organizational directory only** and register. A redirect URI is not needed for device-code sign-in.
3. On **Overview**, copy **Application (client) ID** and **Directory (tenant) ID**. The client ID identifies this Microsoft app; the tenant ID identifies your Microsoft organization. Both are UUIDs, not secrets. A Slack client ID or workspace ID will not work.
4. Under **Authentication → Advanced settings**, enable **Allow public client flows**, then save. Portal layouts with separate settings tabs may show this setting there.
5. Under **API permissions → Add a permission → Microsoft Graph → Delegated permissions**, add **OnlineMeetings.ReadWrite**. Grant administrator consent if your organization requires it. Remove unused permissions from a new dedicated registration.

Use delegated permission, not the similarly named application permission. This integration signs in as the shared organizer. It needs no client secret or application-access policy. See Microsoft's [public client configuration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration) and [createOrGet permissions](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-createorget?view=graph-rest-1.0).

## 2. Configure and sign in once

Put these settings in the app's **`.env`**, using the IDs from Overview:

```dotenv
TEAMS_ENABLED=true
TEAMS_TENANT_ID=your-directory-tenant-uuid
TEAMS_CLIENT_ID=your-application-client-uuid
TEAMS_STATE_DIR=./data/teams
```

From the app directory, with the bot stopped:

```bash
npm install
npm run teams:login
```

Open the Microsoft sign-in URL printed by the command and enter its short code. Sign in as the **shared organizer**, then accept the requested permission. Do not paste passwords, tokens or client secrets into Slack or the model. Device-code sign-in must be allowed by your organization's access policies; if blocked, ask your Microsoft administrator about an approved integration method.

```bash
npm run teams:status
# Start the app using your usual command (npm start or slack run).
```

`teams:status` verifies silent sign-in without creating a meeting. Graph permission and Teams licensing are checked when a member requests a meeting. No Slack reauthentication or extra Slack scopes are needed. Restart after configuring `.env`. Code changes need a restart under `npm start`; `slack run` watches source changes automatically.

Microsoft's MSAL library caches and refreshes tokens. Sign in again if consent is revoked or organization policy requires reauthentication. Stop the bot before signing in again or changing accounts; one bot process owns the cache.

## Permissions and behavior

The tool is included in the gateway's WebSocket request only when configured, signed in, enabled, and permitted for the requester. It executes locally against Microsoft Graph over HTTPS; inference and function-result continuation use the existing Agentic API WebSocket. Microsoft credentials never enter the gateway or model.

Members and admins have `createMeetings: true` by default. Viewers and bot peers cannot create meetings. Disable it for a role in `access.json`:

```json
{ "roles": { "member": { "createMeetings": false } } }
```

Merge that fragment into the existing policy. Permission edits apply to the next request and are checked again immediately before creation. Meeting permission is independent of file creation and poll/document permissions.

The tool accepts `subject`, `starts_at` (an explicit-offset ISO timestamp, or `null` for now), and `duration_minutes` (1–1440). The model receives the requester's Slack timezone and local time and should ask about an ambiguous schedule. The function validates dates, rejects past scheduled times, and converts timestamps to UTC.

One meeting is allowed per Slack request. Parallel subagent calls and retries reuse it, even if the model changes its arguments. Send separate requests for separate meetings; this tool does not edit meetings. Pending requests and confirmed results persist, and Graph's `createOrGet` uses a stable external ID to recover an uncertain result. A new Slack message is a new request and can create another meeting. If a network failure leaves the outcome unknown, check with the organizer before sending another creation request.

If the model fails after creation, the app preserves the confirmed join link in the thread. An invented or unverified link is never used as proof of creation.

## Stored state and troubleshooting

`TEAMS_STATE_DIR` defaults to `data/teams`, ignored by Git. Keep it persistent across restarts and upgrades. It contains:

- `organizer.json`: selected Microsoft account identity.
- `cache.json`: MSAL token cache encrypted with AES-256-GCM.
- `cache.key`: local encryption key.
- `meetings/`: pending requests and confirmed links for duplicate protection.

The directory is private (`0700`); credential and meeting files are private (`0600`). The key is on the same host, so the bot's OS user can decrypt the cache. Protect backups as credentials; encryption does not protect against compromise of that user. Do not put this state in gateway home, expose it through file search, or commit it.

- **Tool missing:** check `TEAMS_ENABLED`, both Microsoft IDs, `npm run teams:status`, and `createMeetings` permission. Incomplete setup leaves the tool disabled.
- **Sign-in expired:** stop the bot, run `npm run teams:login`, then restart. Slack authentication is unaffected.
- **Creation denied (403):** check delegated consent, organizer Teams license, and organization policies.
- **Rate limit (429):** wait before trying again. New Slack messages have new meeting IDs.
- **Corrupt cache:** stop the bot, run `npm run teams:logout`, then `npm run teams:login`. Meeting records remain.

`npm run teams:logout` removes local organizer credentials. It does not delete meetings or revoke consent in Microsoft. Revoke Microsoft consent separately if retiring the integration.
