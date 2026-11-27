# GitHub and artwork MCP tools

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

## Local sticker artwork

See [GIF stickers](./stickers) for installation. `STICKER_MCP_LABEL=sticker_art` registers `http://127.0.0.1:8189/mcp` with only the generation and status tools. The separate `npm run sticker:serve` process runs ComfyUI and the narrow MCP adapter together. It needs no GitHub or paid image API token.

With the defaults, generated PNG files and the Slack app share `.runtime/sticker-art` on this host. If setting `STICKER_ART_DIR`, use the same absolute directory for both processes. A remote ComfyUI instance can be configured in the adapter through `STICKER_COMFY_URL`; the adapter still downloads the result into the shared local directory. Raw ComfyUI's port is not an MCP endpoint.

Stop offering either integration by removing its label from `.env` and restarting the app. The gateway's private managed configuration may remain until the next enabled configuration update; remove retired credentials under your retention policy. Do not expose either local sticker service directly to the internet.
