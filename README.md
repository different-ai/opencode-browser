# OpenCode Browser

Browser automation for [OpenCode](https://github.com/opencode-ai/opencode) via Chrome extension + Native Messaging.

**Inspired by Claude in Chrome** - Anthropic's browser extension that lets Claude Code test code directly in the browser and see client-side errors via console logs. This project brings similar capabilities to OpenCode.

> "Claude in Chrome runs in a side panel that stays open as you browse, working with your existing logins and bookmarks."
> — [@claudeai](https://twitter.com/claudeai), Dec 18, 2024

## Why?

Chrome 136+ blocks `--remote-debugging-port` on your default profile for security reasons. This means DevTools-based automation (like Playwright or chrome-devtools-mcp) triggers a security prompt every time.

OpenCode Browser bypasses this entirely using Chrome's Native Messaging API - the same approach Claude uses. Your automation works with your existing browser session, logins, and bookmarks. No prompts. No separate profiles.

## Installation

```bash
npx opencode-browser install
```

The installer will:
1. Copy the extension to `~/.opencode-browser/extension/`
2. Open Chrome for you to load the extension
3. Register the native messaging host
4. Optionally update your `opencode.json`

## Manual Setup

If you prefer manual installation:

1. **Load the extension**
   - Go to `chrome://extensions`
   - Enable "Developer mode"
   - Click "Load unpacked" and select `~/.opencode-browser/extension/`
   - Copy the extension ID

2. **Run the installer** to register the native host:
   ```bash
   npx opencode-browser install
   ```

3. **Add to opencode.json**:
   ```json
   {
     "mcp": {
       "browser": {
         "type": "local",
         "command": ["npx", "opencode-browser", "start"],
         "enabled": true
       }
     }
   }
   ```

## Available Tools

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_click` | Click an element by CSS selector |
| `browser_type` | Type text into an input field |
| `browser_screenshot` | Capture the visible page |
| `browser_snapshot` | Get accessibility tree with selectors |
| `browser_get_tabs` | List all open tabs |
| `browser_scroll` | Scroll page or element into view |
| `browser_wait` | Wait for a duration |
| `browser_execute` | Run JavaScript in page context |

## Architecture

```
OpenCode ──MCP──> server.js ──Unix Socket──> host.js ──Native Messaging──> Chrome Extension
                                                                                  │
                                                                                  ▼
                                                                            chrome.tabs
                                                                            chrome.scripting
```

- **server.js** - MCP server that OpenCode connects to
- **host.js** - Native messaging host launched by Chrome
- **extension/** - Chrome extension with browser automation tools

No DevTools Protocol = No security prompts.

## Uninstall

```bash
npx opencode-browser uninstall
```

Then remove the extension from Chrome and delete `~/.opencode-browser/` if desired.

## Logs

Logs are written to `~/.opencode-browser/logs/browser-mcp-host.log`

## Platform Support

- macOS ✓
- Linux ✓
- Windows (not yet supported)

## License

MIT

## Credits

Inspired by [Claude in Chrome](https://www.anthropic.com/news/claude-in-chrome) by Anthropic.
