# Agents, tools and steering

## Standard requests

Mention the bot in a channel or send it a DM. Available tools come from the user's current role. The gateway may choose web search, code interpreter or file search when useful; the bridge does not run local shell commands.

Examples:

```text
@bot search for the latest vLLM release notes
@bot calculate the median of 4, 8, 10, 21 and 25 using Python
@bot what does our handbook say about leave?
```

The last example requires a configured [knowledge base](./files). Help and the Home tab reflect your role's enabled capabilities.

## Multi-agent requests

```text
@bot multi compare three retrieval approaches; delegate one approach to each agent
```

The role needs `multiAgent:true`, and `AGENTIC_MULTI_AGENT_ENABLED` must be enabled. `AGENTIC_MAX_CONCURRENT_SUBAGENTS` sets the active subagent limit, default 3. The root coordinator can use the same permitted gateway tools as the subagents. It decides when delegation is useful; enabling the mode alone does not prove an agent was spawned.

Use `multi` again for a follow-up in that thread to continue the stored team. Standard and multi-agent requests use separate response chains. Internal child messages and coordinator commentary are not pasted into Slack as final answers.

Native requests contain `multi_agent: {enabled:true,max_concurrent_subagents:3}`. They omit `max_tool_calls`, which the gateway rejects in this mode.

## Steer a running request

While your standard request is working, reply in **its thread**:

```text
@bot steer focus on operating costs and keep the answer under 200 words
```

The bot sends `response.steer` on the active WebSocket with the running response ID. It confirms the update only after the gateway creates the successor response. The old response may finish naturally or end with reason `steered`; the bridge keeps listening for the updated answer.

Only the requester can steer. Their permissions must still match the running request. A second steering update waits until the first has been applied. A rejected update is reported without pretending it changed the task. No automatic retry occurs after a disconnect.

Steering currently applies to standard chat jobs. Multi-agent runs reject it at the gateway, and the app's checkpointed research workflow does not accept steering. Use Cancel and create an updated research plan instead. Steering accepts text, not new file attachments.

## Execution and evidence

Python and search run on the gateway. The bot displays progress from observed tool events, not estimated percentages. It returns the root answer with web links and file-source names. A failed or incomplete execution is surfaced instead of being represented as a completed calculation.

## Small animated stickers

Ask for a GIF sticker in a normal message, or attach an image with a motion prompt. Roles with file creation can use the local `create_sticker` function, which renders 256 × 256 animations of at most 256 KB and attaches them in the thread. See [sticker creation](./stickers).
