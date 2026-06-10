# dcc-mcp — schedule into the Daily Command Center as a native Claude tool

A zero-dependency MCP server (stdio, Node 18+). Exposes one tool, `schedule_task`,
that posts to the DCC's `/api/dcc/quick-task` endpoint. No `npm install` needed.

## Add it to your Claude config

Add this under `mcpServers` (Claude Desktop / Cowork config). Set the token in the
`env` block — it must match `SECRET_PA_TOKEN` on the DCC server.

```jsonc
{
  "mcpServers": {
    "dcc": {
      "command": "node",
      "args": ["ABSOLUTE/PATH/TO/portable-programming/Repos/daily-command-center/mcp/dcc-mcp/server.js"],
      "env": {
        "DCC_BASE_URL": "https://daily-command-center.onrender.com",
        "DCC_PA_TOKEN": "<your SECRET_PA_TOKEN>"
      }
    }
  }
}
```

On each machine: point `args` at that machine's path to the file and supply the
token via `env` (pull it from your off-git secret store — never commit it).

## The tool

`schedule_task(title, [date], [start], [durationMinutes], [priority], [detail], [tags])`
- `title` required. `date` YYYY-MM-DD (default today). `start` HH:MM (default next
  quarter hour). `durationMinutes` default 30. `priority` low|normal|medium|high|urgent.

## Test the server by hand

```bash
DCC_PA_TOKEN=xxx node server.js
# then paste:
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"schedule_task","arguments":{"title":"MCP test","dry":true}}}
```

## Prefer no MCP setup?

`scripts/dcc-schedule.js` does the same thing as a CLI the assistant can call via
shell from anywhere in the workspace — no client config required. See repo root docs.
