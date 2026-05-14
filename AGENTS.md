# AGENTS.md - OpenCode Browser

Guidelines for AI agents working on this codebase.

## Project Overview

OpenCode Browser provides browser automation tools to OpenCode via an OpenCode **plugin** backed by direct Chrome DevTools Protocol (CDP) connections.

Architecture:

```
OpenCode Plugin <-> CDP HTTP endpoint <-> Browser target WebSocket
```

Components:

1. **Plugin** (`src/plugin.ts`) - OpenCode plugin that exposes `browser_*` tools.
2. **CDP client** (`src/lib/cdp.ts`) - minimal raw WebSocket client and target discovery.
3. **Snapshot helpers** (`src/lib/snapshot.ts`) - accessibility tree rendering and UID resolution.

## Build & Run Commands

```bash
# Install dependencies
bun install

# CLI status/tools
node bin/cli.js status
node bin/cli.js tools

# Validate scripts
node --check bin/cli.js
bun run build
```

## Testing Changes

To test end-to-end you need a Chrome, Chromium, or Electron instance exposing CDP.

Example Chrome launch:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

Then run in a fresh OpenCode process:

```bash
opencode run "use browser_list with browser_url http://127.0.0.1:9222"
opencode run "use browser_snapshot with browser_url http://127.0.0.1:9222"
```

## Code Style Guidelines

### TypeScript (src/)

- 2-space indentation
- Double quotes
- Semicolons required

### JavaScript (bin/)

- 2-space indentation
- Double quotes
- No semicolons

## Important Notes

- Every tool requires an explicit `browser_url`.
- Use `browser_list` to discover `target_id` values for multi-target sessions.
- `browser_click` and `browser_fill` require a prior `browser_snapshot` with the same `browser_url` and `target_id`.
