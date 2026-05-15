# OpenCode Chrome DevTools

Browser automation plugin for [OpenCode](https://opencode.ai) using direct Chrome DevTools Protocol (CDP) connections.

This package now mirrors the browser tool example from OpenWork: no Chrome extension, no native messaging host, no local broker, and no hidden singleton browser state. Each tool call explicitly receives a `browser_url`, and tools can target a specific tab/window with `target_id`.

## Why this architecture

- Direct CDP keeps the package small and predictable.
- `browser_url` makes the browser endpoint explicit and portable.
- `target_id` supports multiple tabs/windows without per-session ownership state.
- The same tools work with Chrome, Chromium, Electron, and remote/proxied CDP endpoints.

## Configure OpenCode

Install or link the package, then add it to `opencode.json` or `opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-chrome-devtools"]
}
```

## Start A Browser

Start Chrome or Chromium with remote debugging enabled:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

Then use `http://127.0.0.1:9222` as `browser_url`.

For Electron apps, pass the app's exposed CDP endpoint as `browser_url`.

## CLI Debugging

The CLI can list tools and run a tool directly after `bun run build`:

```bash
npx opencode-chrome-devtools tools
npx opencode-chrome-devtools tool browser_list --args '{"browser_url":"http://127.0.0.1:9222"}'
npx opencode-chrome-devtools tool browser_snapshot --args '{"browser_url":"http://127.0.0.1:9222"}'
```

If you omit `browser_url` in CLI calls, `OPENCODE_BROWSER_URL` is used, then `http://127.0.0.1:9222`.

## Available Tools

- `browser_list`: list page targets on a CDP endpoint.
- `browser_navigate`: navigate a target to a URL.
- `browser_snapshot`: get an accessibility tree snapshot with `[uid]` markers.
- `browser_click`: click an element by snapshot UID.
- `browser_fill`: fill an input by snapshot UID.
- `browser_eval`: evaluate JavaScript in the page.
- `browser_screenshot`: capture a PNG screenshot and return its saved path.

## Typical Flow

1. Run `browser_list` with a `browser_url`.
2. Choose a `target_id`, or omit it to use the first page target.
3. Run `browser_navigate` if needed.
4. Run `browser_snapshot` to get UIDs.
5. Use `browser_click` or `browser_fill` with a UID from the latest snapshot.
6. Confirm results with `browser_snapshot` or `browser_eval`.

## Troubleshooting

- If `browser_list` fails, confirm the browser was started with `--remote-debugging-port` and that `/json/list` is reachable.
- If `browser_click` or `browser_fill` says no snapshot is cached, call `browser_snapshot` first with the same `browser_url` and `target_id`.
- If a proxied CDP endpoint returns localhost WebSocket URLs, the plugin rewrites them to the proxy host.
