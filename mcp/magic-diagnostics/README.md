# magic-diagnostics MCP server

A zero-dependency stdio MCP server that exposes the running bot's
`/dashboard`, `/debug/logs`, `/debug/runtime-config`, and
`/dashboard/scorecard` endpoints as tools. Lets a Claude Code session
pull live diagnostics on demand without copy-paste.

## Tools

| Name | Backend endpoint | Use when |
|---|---|---|
| `get_diagnostics` | `GET /dashboard` | "Look at the full bot snapshot." |
| `get_logs` | `GET /debug/logs?level=&limit=&since=` | "Show me the last 50 warnings." |
| `get_runtime_config` | `GET /debug/runtime-config` | "What commit is deployed?" |
| `get_scorecard` | `GET /dashboard/scorecard` | "How are closed trades doing?" |

## Setup

1. Set two env vars in the environment that runs Claude Code (your shell, or
   the web environment config):

   ```
   MAGIC_BACKEND_URL=https://your-render-service.onrender.com
   MAGIC_API_TOKEN=<the same value as backend's API_TOKEN env>
   ```

2. The repo's `.mcp.json` registers the server automatically. On first use
   of any `magic-diagnostics` tool, Claude Code prompts to approve the
   server (one-time per project).

3. Try it: ask the session "fetch the latest diagnostics and evaluate."
   The model will call `get_diagnostics` instead of waiting for you to
   paste the JSON.

## Why zero-dep

Runs inside Claude Code's ephemeral web container. Pinning to Node's
built-in `http`/`https` and a hand-rolled JSON-RPC loop means no
`npm install` step — clone the repo and the server works.

## Auth

The server reads `MAGIC_API_TOKEN` and sends it as an `Authorization:
Bearer` header. Matches the bot's `requireApiToken` middleware
(`backend/auth.js`). Set `MAGIC_API_TOKEN` even if the bot's
`API_TOKEN` is unset — the middleware no-ops without a server-side
token but a future flip would lock you out otherwise.

## Tests

```sh
node mcp/magic-diagnostics/server.test.js
```

8 tests: protocol negotiation (initialize, tools/list, notifications,
unknown methods), tool dispatch through a fake HTTP backend, error
propagation, and the no-backend-url guard.

## Adding a new tool

1. Implement an `async toolFoo(args)` function in `server.js` that
   returns the JSON-serialisable payload.
2. Add it to the `TOOLS` array with `name`, `description`,
   `inputSchema`.
3. Add a unit test in `server.test.js` that exercises both the schema
   surface (`tools/list`) and a dispatch test (`tools/call`).

Tools that need new backend routes: add the route to `backend/index.js`
first; the MCP server is a thin shim over what's already exposed.
