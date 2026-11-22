# Connecting MCP clients

Slidango's MCP endpoint lets agents and scripts read decks and suggest changes on your behalf. Every client needs two things:

- the endpoint: `https://<your Slidango>/mcp` (Streamable HTTP, stateless)
- a personal token as the `Authorization` header: `Bearer sld_…`

Create the token in **Account → API tokens**. *Read and suggest changes* lets the client propose edits; *Read only* lets it read. The dialog shows each snippet below with your real URL and token, ready to copy. The examples here use `https://slides.example.com/mcp` and `sld_…`.

A token does what you can do, never more, and never admin tasks. Suggestions appear in the editor with the token's name, so name tokens after the client ("Claude Code", "pi on laptop").

- [Claude Code](#claude-code)
- [Claude Desktop](#claude-desktop)
- [Cursor](#cursor)
- [VS Code](#vs-code)
- [pi](#pi)
- [VibePod](#vibepod)
- [Any other client](#any-other-client)
- [Troubleshooting](#troubleshooting)

## Claude Code

```bash
claude mcp add --transport http slidango https://slides.example.com/mcp \
  --header "Authorization: Bearer sld_…"
```

Add `--scope user` to use Slidango in every project. Check with `claude mcp list`, or `/mcp` inside Claude Code.

## Claude Desktop

Claude Desktop starts local servers only, so [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) (needs Node.js) bridges to Slidango. Open **Settings → Developer → Edit Config** and add under `mcpServers`:

```json
{
  "mcpServers": {
    "slidango": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://slides.example.com/mcp", "--header", "Authorization:${SLIDANGO_AUTH}"],
      "env": { "SLIDANGO_AUTH": "Bearer sld_…" }
    }
  }
}
```

Save and restart Claude Desktop. The header value sits in `env` because some systems split arguments at spaces.

## Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "slidango": {
      "url": "https://slides.example.com/mcp",
      "headers": { "Authorization": "Bearer sld_…" }
    }
  }
}
```

Then enable it in **Settings → MCP**.

## VS Code

`.vscode/mcp.json` in a project, or the user configuration (**MCP: Open User Configuration**):

```json
{
  "servers": {
    "slidango": {
      "type": "http",
      "url": "https://slides.example.com/mcp",
      "headers": { "Authorization": "Bearer sld_…" }
    }
  }
}
```

Start it from the MCP view or with the **Start** button above the entry. To keep the token out of the file, VS Code can prompt for it with an [input variable](https://code.visualstudio.com/docs/copilot/chat/mcp-servers).

## pi

[pi](https://pi.dev) has no MCP built in on purpose; the [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) extension adds it. Install it once and restart pi:

```bash
pi install npm:pi-mcp-adapter
```

Then add Slidango to `~/.config/mcp/mcp.json` (all projects) or `.mcp.json` (one project):

```json
{
  "mcpServers": {
    "slidango": {
      "url": "https://slides.example.com/mcp",
      "headers": { "Authorization": "Bearer sld_…" }
    }
  }
}
```

Check with `/mcp` inside pi, or `pi-mcp-adapter doctor` in a terminal. The adapter connects lazily: Slidango shows up as connected after the first tool call.

## VibePod

[VibePod](https://github.com/VibePod/vibepod-cli) runs each agent in a container and keeps the agent's settings in its profile (`~/.config/vibepod/agents/<agent>/` on Linux, `~/Library/Application Support/vibepod/agents/<agent>/` on macOS). Set Slidango up once inside the agent and it stays:

```bash
vp run claude
# inside the agent:
claude mcp add --transport http slidango https://slides.example.com/mcp \
  --header "Authorization: Bearer sld_…"
```

For pi, start `vp run pi` and follow [pi](#pi).

Inside a container, `localhost` is the container itself. Use Slidango's real address; for a Slidango on the same machine, `host.docker.internal` with the port works on Docker Desktop.

## Any other client

Point it at the endpoint with Streamable HTTP and send the token as a header with every request:

```
URL:    https://slides.example.com/mcp
Header: Authorization: Bearer sld_…
```

Clients that only start local (stdio) servers can use `mcp-remote` as shown for [Claude Desktop](#claude-desktop).

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `401` / "needs an API token" | Header missing or misspelled; it must be `Authorization: Bearer sld_…`. |
| Token worked, now `401` | Token revoked or expired, or your account was disabled. Create a new one. |
| "This token is read-only" | Create a token with *Read and suggest changes*. |
| "Deck … not found" | You can't see that deck (members only), or the id is wrong; `list_decks` shows yours. |
| `429` | More than 120 requests a minute from one token. |
| Connection refused from a container | `localhost` inside the container; see [VibePod](#vibepod). |
| SSO login page instead of JSON | Your instance runs an older Caddy configuration; `deploy/caddy-auth/oidc.caddy` must let token requests through. |
