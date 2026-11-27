import { defineConfig } from 'vitepress';
export default defineConfig({
  title: 'Slack Agentic API',
  description: 'A Slack interface for your self-hosted agents, tools, and knowledge.',
  base: process.env.DOCS_BASE || '/',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    siteTitle: 'Slack Agentic API',
    nav: [{ text: 'Start here', link: '/quick-start' }, { text: 'Capabilities', link: '/features' }, { text: 'Hosting', link: '/hosting' }],
    sidebar: [
      { text: 'Get started', items: [{ text: 'Overview', link: '/' }, { text: 'Quick start', link: '/quick-start' }, { text: 'Slack app setup', link: '/slack-setup' }, { text: 'Source gateway', link: '/gateway' }] },
      { text: 'Use the assistant', items: [{ text: 'Agents and steering', link: '/features' }, { text: 'Files and knowledge', link: '/files' }, { text: 'Research', link: '/research' }, { text: 'GIF stickers', link: '/stickers' }, { text: 'Polls and documents', link: '/polls-and-documents' }, { text: 'Teams meetings', link: '/teams-meetings' }] },
      { text: 'Run it', items: [{ text: 'Hosting on your machine', link: '/hosting' }, { text: 'GitHub, Kanban and artwork MCP', link: '/mcp' }, { text: 'Configuration and operations', link: '/operations' }, { text: 'Protocol and architecture', link: '/architecture' }, { text: 'Development and docs', link: '/development' }] },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/EmbeddedLLM/slack-agentic-api-app' }],
    search: { provider: 'local' },
    outline: [2, 3],
    footer: { message: 'Apache-2.0 · Based on EmbeddedLLM’s Slack Pi Agent', copyright: 'Built with Agentic API and vLLM' },
  },
});
