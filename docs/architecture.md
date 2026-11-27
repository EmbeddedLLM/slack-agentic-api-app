# Architecture

`index.js` owns Slack events, access policy, the bounded job scheduler, per-thread serialization, attachment preparation, output rendering and interactive plans. `src/agentic-client.js` owns WebSocket transport and response validation. `src/research.js` owns the research workflow and checkpoints. `src/steering.js` tracks accepted updates through successor creation; `src/knowledge-client.js` handles administrative file uploads and indexing.

`scripts/start-app.js` and `src/app-runtime.js` supervise the source gateway and Slack bot together. The gateway must pass `/ready` before the bot starts. Unexpected child exits restart the pair with a rate limit; shutdown signals or a lost launcher parent clean up both process groups. vLLM runs separately. Set `MANAGE_GATEWAY=false` when another service owns the gateway.

## WebSocket contract

A job connects to `AGENTIC_WS_URL`, normally `ws://127.0.0.1:9000/v1/responses`, with an optional `Authorization: Bearer …` upgrade header. Remote TLS endpoints use `wss://`. URLs with credentials, query parameters or fragments are rejected. The Node `ws` client supports the auth header; no credentials are placed in the URL.

Each turn sends one text frame:

```json
{
  "type": "response.create",
  "stream_id": "unique-request-id",
  "model": "served-model-id",
  "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Question"}]}],
  "tools": [{"type": "web_search"}],
  "store": true,
  "stream": true,
  "max_output_tokens": 8192,
  "max_tool_calls": 12,
  "multi_agent": {"enabled": false}
}
```

A continuation adds `previous_response_id`. Declared tools and instructions are sent again for every response. Frames for another `stream_id` are ignored. Only a valid `response.completed` with a completed response, an ID and assistant output commits local memory. Errors, incomplete responses, dropped connections, empty answers and undeclared client tool calls fail the job. Declared local functions return matching `function_call_output` items and continue over the same WebSocket, retaining tools and multi-agent settings. Raw provider errors are not sent to Slack.

There is one connection per active Slack job. Research reuses its connection across section, synthesis and summary requests. A normal chat job closes its connection after the response. Subsequent chat jobs use durable `previous_response_id` continuation on a new connection. This bounds connection lifetime and means a disconnect can cancel one job without affecting another. The gateway has no `response.cancel` frame used by this client: cancellation terminates the job's connection.

The bridge does not automatically retry network failures, because a tool may already have run. It retries one model answer containing unparsed tool-call markup, resetting the local response pointer first, unless a local file was generated or a Slack write was attempted. An interrupted research section is rerun only when someone presses Resume.

Slack's Web API and file downloads still use HTTPS, and Slack Socket Mode uses its own WebSocket connection. The bridge-to-Agentic-API inference path uses WebSocket exclusively. The gateway's connection to vLLM is configured separately.

The protocol was checked against [Agentic API's WebSocket documentation](https://github.com/vllm-project/agentic-api/blob/19b392ce07a13b46b2b6cc7f5353246459088946/docs/api/index.md#ws-v1responses).

## State and boundaries

Chat stores only `{responseId}` locally, in a file named by a hash of channel, thread, requester, role permissions, gateway URL, model and multi-agent mode. Permission changes create a new chain. Recent Slack history is still included within a character budget to capture other users' messages. Posted messages are visible to everyone with access to that Slack conversation; role isolation is not privacy from channel participants.

Without `AGENTIC_SESSION_DIR`, chat sends `store:false` and relies on bounded Slack history. Planning also uses `store:false`. Research always uses `store:true` so checkpoints can survive a socket or bot restart. Persistent IDs require keeping the same gateway database and authentication identity.

Research groups the approved coverage into at most 2, 4 or 6 sections for quick, standard or deep runs. Each section uses gateway web search, with requested domain filters. A section is committed only after a completed response containing successful search calls and retrieved source URLs. Synthesis and summary have no tools. The saved report includes the retrieved source list; source presence does not prove every generated claim is correct.

Reports and checkpoints contain sensitive conversation data. Only known secret strings are redacted; encoded or previously unknown secrets cannot be guaranteed absent. Raw conversation and tool history may remain in the gateway's own database.

The gateway owns web search, code interpreter and file search. Python runs in fresh Eryx sandboxes with printed text output, without network or artifact exchange. No local shell, file browser or MCP server is exposed. Slack attachments are decoded in the bridge; bounded text is sent as native UTF-8 `input_file` data and images as `input_image` data URLs. Slack file downloads accept only `https://files.slack.com` with no redirects. Upload folders are removed after each job.

## Multi-agent and steering

`multi_agent` is redeclared on every multi-agent response, including research synthesis and resume. These requests omit the incompatible `max_tool_calls` field. Only root assistant messages (excluding commentary) become the Slack answer. Tool and delegation events update the job status.

`steer <update>` targets the requester's running standard job in the same thread. The control frame carries `type: response.steer`, `previous_response_id` and `input`, without `stream_id` or replacement model/tool settings. An accepted acknowledgement means retained, not applied. The bridge waits for the successor's `response.created`, handles a parent completion that races the update, and persists only the final successor response. Research and multi-agent jobs cannot be steered in this version.

## Knowledge storage

Inference, including file search, uses WebSocket. Administrative ingestion uses the gateway HTTP Files and Vector Stores APIs, as in its playground. Store IDs are selected by access policy, not user prompts. Slack attachments remain request inputs; they are not automatically added to a shared knowledge base. File citations are rendered with filenames.

## Local sticker function

For file-authorized chat roles, `create_sticker` validates model-provided SVG frames, renders a bounded GIF in a separate worker, and queues the bytes for the Slack reply. No generated JavaScript, shell commands or filesystem paths are executed. Stored responses continue by ID after a function call; stateless requests replay the original public output and matching call result. Local functions have bounded rounds, cancellation and repeated-call protection. See [GIF stickers](./stickers).

## Local Slack action functions

`src/slack-tools.js` implements `create_poll` and `save_channel_document`. Function definitions and permission-scoped handlers are supplied to `AgenticClient.respond`, using the same standard function continuation and multi-agent live injection as stickers. Destinations come from the originating Slack job. Arguments are validated and scrubbed before use, and permissions are checked before writes. Poll interactions use Bolt Socket Mode without model inference. Persisted per-request action results prevent identical function calls from duplicating polls, files or bookmarks; per-poll serialization preserves simultaneous votes. See [polls and documents](./polls-and-documents) for scopes, limits and storage.
