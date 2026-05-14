---
name: browser-automation
description: Reliable browser automation through explicit Chrome DevTools Protocol endpoints.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  domain: browser
---

## What I do

- Provide a safe, composable workflow for CDP-backed browsing tasks
- Use explicit `browser_url` values; do not assume a hidden browser singleton
- Use `browser_snapshot` UIDs for click and fill actions
- Confirm state changes after each action with `browser_snapshot` or `browser_eval`

## Best-practice workflow

1. Inspect targets with `browser_list({ browser_url })`
2. Pick a `target_id`, or omit it to use the first page target
3. Navigate with `browser_navigate` if needed
4. Discover candidates using `browser_snapshot`
5. Click or fill using a UID from the latest snapshot
6. Confirm using `browser_snapshot` or `browser_eval`

## CLI-first debugging

- List all available tools: `npx @different-ai/opencode-browser tools`
- Run one tool directly: `npx @different-ai/opencode-browser tool browser_list --args '{"browser_url":"http://127.0.0.1:9222"}'`
- Set a default endpoint: `OPENCODE_BROWSER_URL=http://127.0.0.1:9222 npx @different-ai/opencode-browser status`

This path is useful for reproducing CDP endpoint or snapshot issues quickly before running a full OpenCode session.

## Available tools

- `browser_list`
- `browser_navigate`
- `browser_snapshot`
- `browser_click`
- `browser_fill`
- `browser_eval`
- `browser_screenshot`

## Troubleshooting

- If `browser_list` fails, verify the browser was started with `--remote-debugging-port`
- If `browser_click` or `browser_fill` cannot find a UID, refresh the snapshot first
- Use `browser_eval` for page-specific checks that are not visible in the accessibility tree
- Confirm results after each action
