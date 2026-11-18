# Development and documentation

## App checks

```bash
npm ci --ignore-scripts
npm test
```

Tests use a local WebSocket server and recorded Slack API calls. They cover mode/permission routing, tool declarations, native file inputs, file citations, research checkpoints, steering success/failure races, local function continuations, and decoded GIF frames/transparency. They do not use your Slack or search credentials.

A real-gateway check uses deterministic model replies and temporary gateway state. It checks native input files, mode admission, actual isolated Python execution, uploads/indexing/search/citations, and steering successors. It requires the interpreter runtime prerequisites:

```bash
AGENTIC_SERVER_BIN="$PWD/.runtime/agentic-api/target/release/agentic-server" \
  node scripts/gateway-integration.js
```

## Documentation website

The site uses VitePress, matching the original Slack Pi app's documentation approach. Install the documentation dependencies, including the bundler's platform package:

```bash
npm ci --ignore-scripts
npm run docs:dev
```

`--ignore-scripts` avoids downloading Chromium while installing dependencies for docs. It is not the installation path for verifying PDF export.

Build and preview:

```bash
npm run docs:build
npm run docs:preview
```

The static output is `docs/.vitepress/dist`. Local preview uses `/` by default. For GitHub project Pages, build with:

```bash
DOCS_BASE=/slack-agentic-api-app/ npm run docs:build
```

The included Pages workflow is manually triggered. When you are ready to publish, push the changes, choose **GitHub Actions** as the repository's Pages source, and run **Publish documentation**. The intended URL is `https://embeddedllm.github.io/slack-agentic-api-app/`; it is not live until deployment succeeds.

## References

The request builder and file workflow follow the [Agentic API playground](https://github.com/vllm-project/agentic-api/tree/main/application_examples/agentic_playground). The [upstream WebSocket documentation](https://github.com/vllm-project/agentic-api/blob/main/docs/api/index.md#ws-v1responses) defines steering and continuation semantics. The gateway source remains a separate repository under `.runtime/` and is not vendored into this app.
