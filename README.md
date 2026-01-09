# OpenCode Browser

Browser automation plugin for [OpenCode](https://github.com/opencode-ai/opencode).

Control your real Chromium browser (Chrome/Brave/Arc/Edge) using your existing profile (logins, cookies, bookmarks). No DevTools Protocol, no security prompts.

## Why this architecture

This version is optimized for reliability and predictable multi-session behavior:

- **No WebSocket port** → no port conflicts
- **Chrome Native Messaging** between extension and a local host process
- A local **broker** multiplexes multiple OpenCode plugin sessions and enforces **per-tab ownership**

## Installation

```bash
npx @different-ai/opencode-browser install
```

The installer will:

1. Copy the extension to `~/.opencode-browser/extension/`
2. Walk you through loading + pinning it in `chrome://extensions`
3. Ask for the extension ID and install a **Native Messaging Host manifest**
4. Update your `.opencode.json` to load the plugin

### Configure OpenCode

Your `.opencode.json` should contain:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@different-ai/opencode-browser"]
}
```

## How it works

```
OpenCode Plugin <-> Local Broker (unix socket) <-> Native Host <-> Chrome Extension
```

- The extension connects to the native host.
- The plugin talks to the broker over a local unix socket.
- The broker forwards tool requests to the extension and enforces tab ownership.

## Per-tab ownership

- First time a session touches a tab, the broker **auto-claims** it for that session.
- Other sessions attempting to use the same tab will get an error.

Tools:

- `browser_claim_tab({ tabId })`
- `browser_release_tab({ tabId })`
- `browser_list_claims()`

## Available tools

- `browser_version`
- `browser_status`
- `browser_get_tabs`
- `browser_navigate`
- `browser_click`
- `browser_type`
- `browser_screenshot`
- `browser_snapshot`
- `browser_scroll`
- `browser_wait`
- `browser_execute`

## Troubleshooting

**Extension says native host not available**
- Re-run `npx @different-ai/opencode-browser install`
- Confirm the extension ID you pasted matches the loaded extension in `chrome://extensions`

**Tab ownership errors**
- Use `browser_list_claims()` to see who owns a tab
- Use `browser_claim_tab({ tabId, force: true })` to take over intentionally

## Uninstall

```bash
npx @different-ai/opencode-browser uninstall
```

Then remove the unpacked extension in `chrome://extensions` and remove the plugin from `.opencode.json`.
