/**
 * How to connect common MCP clients to Slidango's endpoint with a personal token.
 * Kept in sync with docs/mcp-clients.md.
 */
export interface ClientGuide {
  id: string
  name: string
  /** Short steps before the snippet. */
  steps: string[]
  code: string
  /** Where the snippet goes, e.g. a file path or "Terminal". */
  where: string
  /** Something easy to trip over. */
  note?: string
}

export function clientGuides(url: string, token: string): ClientGuide[] {
  const header = `Bearer ${token}`
  const json = (value: unknown) => JSON.stringify(value, null, 2)
  const httpEntry = { url, headers: { Authorization: header } }
  const local = /\/\/(localhost|[^/]*\.localhost|127\.0\.0\.1)[:/]/.test(url)
  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      where: 'Terminal',
      steps: ['Run this once. Add --scope user to use Slidango in every project.', 'Check with: claude mcp list'],
      code: `claude mcp add --transport http slidango ${url} \\\n  --header "Authorization: ${header}"`,
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      where: 'Settings → Developer → Edit Config (claude_desktop_config.json)',
      steps: [
        'Claude Desktop starts local servers only, so mcp-remote (needs Node.js) bridges to Slidango.',
        'Add the entry under mcpServers, save, restart Claude Desktop.',
      ],
      code: json({
        mcpServers: {
          slidango: {
            command: 'npx',
            args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${SLIDANGO_AUTH}'],
            env: { SLIDANGO_AUTH: header },
          },
        },
      }),
      note: 'The header value sits in env because some systems split arguments at spaces.',
    },
    {
      id: 'cursor',
      name: 'Cursor',
      where: '~/.cursor/mcp.json (or .cursor/mcp.json in a project)',
      steps: ['Add the entry under mcpServers, then enable it in Settings → MCP.'],
      code: json({ mcpServers: { slidango: httpEntry } }),
    },
    {
      id: 'vscode',
      name: 'VS Code',
      where: '.vscode/mcp.json (or "MCP: Open User Configuration")',
      steps: ['Add the entry under servers, then start it from the MCP view or the file’s Start button.'],
      code: json({ servers: { slidango: { type: 'http', ...httpEntry } } }),
    },
    {
      id: 'pi',
      name: 'pi',
      where: '~/.config/mcp/mcp.json (or .mcp.json in a project)',
      steps: [
        'pi has no MCP built in; install the adapter once: pi install npm:pi-mcp-adapter, then restart pi.',
        'Add the entry, then check with /mcp inside pi or pi-mcp-adapter doctor.',
      ],
      code: json({ mcpServers: { slidango: httpEntry } }),
      note: 'The adapter connects lazily, on the first Slidango tool call.',
    },
    {
      id: 'vibepod',
      name: 'VibePod',
      where: 'Inside the agent started with vp run',
      steps: [
        'VibePod runs each agent in a container and keeps its settings in VibePod’s profile, so set Slidango up once inside the agent.',
        'For Claude Code: start vp run claude, then run the Claude Code command from its tab. For pi: vp run pi, then follow the pi tab.',
      ],
      code: `vp run claude\n# then, inside the agent:\nclaude mcp add --transport http slidango ${url} \\\n  --header "Authorization: ${header}"`,
      note: local
        ? 'Inside a container, localhost is the container itself. Use Slidango’s real address, or host.docker.internal with the port on Docker Desktop.'
        : 'The container must be able to reach this address.',
    },
    {
      id: 'other',
      name: 'Other',
      where: 'Your client’s MCP settings',
      steps: [
        'Slidango speaks Streamable HTTP (stateless) at the URL below.',
        'Send the token as the Authorization header with every request.',
      ],
      code: `URL:    ${url}\nHeader: Authorization: ${header}`,
    },
  ]
}
