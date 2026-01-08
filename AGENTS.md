# AGENTS.md - OpenCode Browser

Guidelines for AI agents working on this codebase.

## Project Overview

OpenCode Browser is an MCP (Model Context Protocol) server that provides browser automation
tools to OpenCode. It consists of two components:

1. **MCP Server** (`src/mcp-server.ts`) - TypeScript server using `@modelcontextprotocol/sdk`
2. **Chrome Extension** (`extension/`) - JavaScript extension that executes browser commands

Architecture:
```
OpenCode <--STDIO--> MCP Server <--WebSocket:19222--> Chrome Extension
```

## Build & Run Commands

```bash
# Install dependencies
bun install

# Run MCP server directly (for testing)
bun run src/mcp-server.ts

# Run via CLI (how OpenCode calls it)
bun run bin/cli.js serve

# Install extension (interactive)
bun run bin/cli.js install

# Check status
bun run bin/cli.js status
```

## Testing Changes

**IMPORTANT**: To test changes to the MCP server, you must run a fresh OpenCode instance:

```bash
# Test with a new OpenCode process (loads fresh code)
opencode run "use browser_status to check browser connection"

# Test navigation
opencode run "navigate to https://example.com and take a snapshot"
```

This spawns a new process that loads the updated code. The current OpenCode session
uses cached code and won't reflect your changes until restarted.

To verify MCP server is running:
```bash
opencode mcp list    # Should show "browser" as connected
lsof -i :19222       # Check WebSocket port
```

## Code Style Guidelines

### TypeScript (src/)

**Imports** - Use ES modules with explicit `.js` extensions for SDK imports:
```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
```

**Formatting**:
- 2-space indentation
- Double quotes for strings
- Semicolons required
- Max line length ~100 chars

**Types**:
- Use explicit types for function parameters and returns
- Use `any` sparingly, prefer proper typing
- Use zod schemas for tool argument validation

**Naming**:
- `camelCase` for functions and variables
- `PascalCase` for types/interfaces
- `SCREAMING_SNAKE_CASE` for constants
- Prefix private/internal functions with purpose (e.g., `handleMessage`, `sendToChrome`)

**Error Handling**:
- Always catch and handle errors in async functions
- Use descriptive error messages that help users debug
- Log errors to stderr with `console.error()` (never stdout for MCP servers)

**MCP Tool Registration Pattern**:
```typescript
mcpServer.tool(
  "tool_name",
  "Description of what the tool does",
  {
    param: z.string().describe("Parameter description"),
    optional: z.number().optional().describe("Optional param"),
  },
  async ({ param, optional }) => {
    const result = await doSomething(param, optional);
    return {
      content: [{ type: "text", text: result }],
    };
  }
);
```

### JavaScript (extension/)

**Style**:
- ES6+ syntax (async/await, arrow functions, destructuring)
- 2-space indentation, double quotes, no semicolons

**Chrome Extension APIs**:
- Use `chrome.tabs`, `chrome.scripting`, `chrome.action`
- Always handle errors from Chrome APIs
- Use Manifest V3 patterns (service worker, not background page)

## File Structure

```
opencode-browser/
├── src/
│   └── mcp-server.ts      # Main MCP server (TypeScript)
├── extension/
│   ├── background.js      # Chrome extension service worker
│   ├── manifest.json      # Extension manifest (v3)
│   └── icons/             # Extension icons
├── bin/
│   └── cli.js             # CLI entry point
├── package.json           # NPM package config
└── opencode.json          # Local MCP config for testing
```

## Key Concepts

### MCP Server
- Uses STDIO transport (stdin/stdout for JSON-RPC)
- Never write to stdout except JSON-RPC messages
- All logging goes to stderr via `console.error()`

### WebSocket Communication
- Server listens on port 19222
- Chrome extension connects as client
- Message format: `{ type, id, tool, args }` for requests
- Response format: `{ type: "tool_response", id, result/error }`

### Tool Execution Flow
1. OpenCode calls MCP tool via STDIO
2. MCP server sends WebSocket message to extension
3. Extension executes via Chrome APIs
4. Extension returns result via WebSocket
5. MCP server returns result via STDIO

## Debugging Tips

1. **Check MCP connection**: `opencode mcp list`
2. **Check WebSocket**: `lsof -i :19222`
3. **Extension logs**: Open Chrome DevTools on extension service worker
4. **MCP server logs**: Check stderr output when running directly

## Important Notes

- **No stdout in MCP server**: Writing to stdout corrupts JSON-RPC protocol
- **Port 19222**: Fixed port for WebSocket, not configurable
- **Single connection**: Only one Chrome extension can connect at a time
- **CSP limitations**: `browser_execute` may fail on sites with strict CSP
