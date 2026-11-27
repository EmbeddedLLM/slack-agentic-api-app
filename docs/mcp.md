# GitHub, AgentKanban and artwork MCP tools

MCP tools run inside Agentic API. The Slack app declares a trusted server label and allowed tool names in each WebSocket request; URLs and credentials stay in the gateway configuration. Local Slack actions such as `save_channel_document` and `create_sticker` remain function calls executed by the app.

## GitHub: public repositories, read-only

The app uses GitHub's [official hosted MCP server](https://github.com/github/github-mcp-server#remote-github-mcp-server) at `https://api.githubcopilot.com/mcp/`. You do not need its Docker image or a local GitHub MCP process.

1. Create a dedicated [fine-grained token](https://github.com/settings/personal-access-tokens/new) with **Public repositories (read-only)** access. Do not grant private repositories or extra account permissions.
2. Add `GITHUB_MCP_TOKEN=your_token` to the private `.env.gateway` file.
3. Add `GITHUB_MCP_LABEL=github_public` to `.env`.
4. Restart the combined gateway/bot launcher. No Slack reauthentication is needed.

The launcher writes a managed `[mcp_servers.github_public]` section in `$AGENTIC_API_HOME/config.toml`, preserving the other settings. It sets `X-MCP-Readonly: true` and an explicit tool allowlist for reading/searching issues, PRs and code. The file is created with mode `0600` because the current gateway requires literal authorization headers there. The credential is never sent in the model's request payload. For an externally managed gateway, register the same server and headers yourself; a request label alone does not configure a connection.

Public-only access is enforced by the restricted token. Read-only mode prevents writes but does **not** restrict a broad token to public repositories. Do not reuse a personal CLI credential with private repository access for a workspace-wide assistant. Replace expired tokens in `.env.gateway` and restart the launcher.

Roles with `web_search` receive these GitHub tools when the label is enabled. GitHub source content remains untrusted evidence. The model can retrieve an issue, paginate open PRs including drafts, inspect relevant details, then call `save_channel_document` to write the report and bookmark it in the requesting channel. There is no roadmap-specific parser or report template.

MCP improves direct access to GitHub; it does not accelerate language-model generation. The progress message reports drafting character counts, and document requests have a separate configurable allowance described in [gateway timeouts](./gateway#request-timeouts). GitHub rate limits and token expiration still apply.

## AgentKanban board

The app connects to the authenticated MCP endpoint at `https://agentkanban.embeddedllm.com/mcp`.

1. Create a project-scoped key in AgentKanban’s **MCP Access** settings.
2. Save `VIBE_KANBAN_API_KEY=your_key` in the private `.env.gateway` file.
3. Set `VIBE_KANBAN_MCP_LABEL=vibe_kanban` in `.env`.
4. Restart the combined app/gateway launcher. No Slack reauthentication is needed.

The launcher adds a trusted `[mcp_servers.vibe_kanban]` block to gateway home with the endpoint, its seven verified tool names and an Authorization bearer header. Agentic API uses `headers` in its TOML format, the equivalent of `http_headers` in the configuration supplied by AgentKanban. Credentials remain in private gateway files and never enter model requests.

| Tool | Action |
| --- | --- |
| `get_identity` | Identify the connected project and authenticated board member |
| `list_statuses` | List the project’s Kanban columns |
| `list_issues` | Search or paginate the project’s issues |
| `create_issue` | Create an issue in a chosen column |
| `move_issue` | Move an issue to another column |
| `assign_issue` | Add a board member as an assignee |
| `add_comment` | Add a comment under the key owner’s identity |

Human members and admins receive these tools when their role has `kanban: true` (the default). Viewers and bot peers do not. Set `roles.member.kanban` to `false` in `access.json` to disable member access. All authorized users share the project and identity allowed by this key; the integration does not use each Slack member’s personal AgentKanban login. Connect a project you intend to share with those users.

```text
@Meow-AI show the columns on our AgentKanban board
@Meow-AI list the issues in In Progress
@Meow-AI create an issue in Backlog titled Update the onboarding guide
@Meow-AI move issue ABC-12 to In Progress
@Meow-AI add a comment to ABC-12: the setup guide is ready for review
```

The model resolves actual issue/column IDs before writing and acts on an explicit request. Assignments need a verified AgentKanban member ID; Slack user IDs are not board member IDs, and “assign to me” does not automatically mean the shared key owner. This server does not expose issue deletion or editing existing titles/descriptions. Board text is untrusted evidence. Replies and confirmations stay in the requesting Slack thread.

Rotate the key in `.env.gateway` and restart the launcher. If a write’s result is uncertain, inspect the board before retrying; the remote server does not advertise an idempotency key for writes.

## Local sticker artwork

See [GIF stickers](./stickers) for installation. `STICKER_MCP_LABEL=sticker_art` registers `http://127.0.0.1:8189/mcp` with only the generation and status tools. The separate `npm run sticker:serve` process runs ComfyUI and the narrow MCP adapter together. It needs no GitHub or paid image API token.

With the defaults, generated PNG files and the Slack app share `.runtime/sticker-art` on this host. If setting `STICKER_ART_DIR`, use the same absolute directory for both processes. A remote ComfyUI instance can be configured in the adapter through `STICKER_COMFY_URL`; the adapter still downloads the result into the shared local directory. Raw ComfyUI's port is not an MCP endpoint.

Stop offering an integration by removing its label from `.env` and restarting the app. The gateway's private managed configuration may remain until the next enabled configuration update; remove retired credentials under your retention policy. Do not expose either local sticker service directly to the internet.
