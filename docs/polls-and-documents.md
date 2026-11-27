# Polls and channel documents

Members and admins can ask the assistant to create an interactive poll or save a Markdown document in their current channel. Both are local function tools declared in the Agentic API WebSocket request, alongside `create_sticker`. The gateway model chooses the function and arguments; the bridge calls Slack and returns the actual result over the same WebSocket.

## Create a poll

```text
@bot create a poll: Which day should we demo? Tuesday, Wednesday, or Thursday
```

`create_poll` accepts `question` and `options` (2–10 distinct choices). It posts a [Block Kit message](https://docs.slack.dev/reference/block-kit/) in the request's thread, with a vote button for each choice and visible totals. Slack does not expose a dedicated poll Web API method; this implementation uses Slack's own message controls without installing another polling app.

Each authorized human user has one vote and can change it by selecting another option. Repeated clicks on the same choice do not add votes. The creator or an app admin can use **Close poll** to stop voting. Votes and closed status survive bot restarts. The app must be running to process buttons. Voter IDs are stored locally to enforce one vote per person; the message displays aggregate totals, not voter names. This is not an anonymous-ballot system.

## Save a document and bookmark it

```text
@bot document the decisions in this thread as decisions.md and bookmark it in this channel
@bot write a deployment runbook based on this discussion and save it to channel bookmarks
```

`save_channel_document` accepts `title`, `filename` and the complete Markdown `content`. It:

1. Saves a UTF-8 `.md` file locally (at most 200 KB, or `MAX_FILE_BYTES` if lower).
2. Uploads that file to the requesting thread using Slack's current external upload flow through `files.uploadV2`.
3. Resolves the uploaded file's Slack permalink and adds it to the current channel's bookmarks with [`bookmarks.add`](https://docs.slack.dev/reference/methods/bookmarks.add/).

The bookmark opens the Slack-hosted file; the Markdown bytes live in the file, not inside the bookmark. No public file link is created. Slack controls who can access the uploaded file. Each new request creates a new document; this tool does not edit or overwrite earlier documents. Review generated summaries before treating them as an authoritative record.

For GitHub-based reports, enable the [official GitHub MCP integration](./mcp) to read issues and current open/draft PRs directly. The model writes the report into the document tool arguments once. Progress shows drafting character counts separately from saving; authorized channel requests mentioning bookmarks or saving a document/report can use `AGENTIC_DOCUMENT_TIMEOUT_MS` (20 minutes by default). More time prevents premature cancellation but does not increase model generation speed.

The document content schema deliberately omits string length constraints because older XGrammar versions can make constrained generation much slower for long bounded strings ([upstream issue](https://github.com/mlc-ai/xgrammar/issues/852)). Nonempty content and the 200 KB/configured byte limit are still enforced locally before any file write or Slack upload.

If the file uploads but bookmarking fails, the result preserves the file link and reports `uploaded:true, bookmarked:false`. For example, Slack may reject bookmarking when the app lacks its scope or the channel has reached the 100-bookmark limit. The assistant must report the partial result rather than claim success. You can bookmark the uploaded file manually after correcting the issue.

## Permissions and setup

The manifest includes `chat:write`, `files:write`, `files:read` and **`bookmarks:write`**. Existing installations must add the bookmark scope and reinstall the app to grant it; restarting only the Node process does not grant new scopes. See [Slack setup](./slack-setup) for the CLI workflow. Interactivity must remain enabled for poll buttons.

The role flag `slackActions:true` enables creation of polls and channel documents; it defaults to true for members and admins. Saving documents additionally requires `createFiles:true`. Set `slackActions:false` to disable both for a role. Role and channel permissions are checked again immediately before execution. Authorized human viewers may vote, but cannot create polls or documents by default. Trusted bot peers cannot invoke these channel write tools or vote. The tools are omitted in DMs and research execution/follow-ups; request them separately in a channel. Standard and `multi` channel requests can use them.

Neither function accepts a channel ID, URL, filesystem path or user ID from the model. The destination is bound to the Slack request. There are at most four distinct poll/document actions per request, and identical calls in that request reuse their saved result. If a write's result is uncertain, it is not automatically retried. Check the thread before issuing a new request. Cancelling a model request does not undo a poll or file already posted.

## Persistent storage

`SLACK_TOOLS_DIR` defaults to `data/slack-tools`. Keep it on persistent storage alongside other app data and run one bridge process per Slack installation. It contains:

- `<action-id>.json`: poll votes/state or the document upload/bookmark result.
- `documents/<action-id>/<filename>.md`: the local Markdown copy.

Directories and files are created with private permissions and ignored by Git. Back them up under your team's retention policy. Removing poll records makes old voting buttons unavailable. Deleting a local record or document does not remove its Slack message, file or bookmark.
