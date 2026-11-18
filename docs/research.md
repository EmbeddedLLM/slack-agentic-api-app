# Research

Start with `@bot research <question>`. The bot drafts a plan with coverage, depth, domain filters and any clarifying questions. Edit it or reply with changes, then press **Start research**.

The workflow collects evidence by section, synthesizes a report and writes a Slack summary. Each completed response is checkpointed. With `RESEARCH_MULTI_AGENT=true`, roles with `multiAgent:true` use native gateway orchestration on every research response. Other roles run the same workflow with one agent. Permitted code interpreter and file-search tools can accompany web search.

Research still requires web search and verifies that a section returned successful search calls and source URLs before saving it. It is a web research workflow; ask ordinary knowledge-base questions through standard chat when no web research is needed.

Cancel closes the job's connection and preserves completed sections. Resume repeats the interrupted section. It keeps the run's original execution mode and store IDs, and refuses to resume if current permissions no longer allow them. Adding new permissions does not silently expand an existing checkpoint.

The result includes Markdown and optional PDF. Follow-up questions use bounded saved report and evidence notes without fresh searches. Generated reports include linked sources and limitations; they are not independently fact-checked.

Pending plans are in memory and expire on restart. Research checkpoints and reports are on disk. Keep both local research state and the gateway database if you need to resume after restarting.
