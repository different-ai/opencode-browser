# OpenCode Browser

Browser automation MCP server for [OpenCode](https://github.com/opencode-ai/opencode).

Control your real Chrome browser with existing logins, cookies, and bookmarks. No DevTools Protocol, no security prompts.

## Why?

Chrome 136+ blocks `--remote-debugging-port` on your default profile for security reasons. DevTools-based automation (like Playwright) triggers a security prompt every time.

OpenCode Browser uses a simple WebSocket connection between an MCP server and a Chrome extension. Your automation works with your existing browser session - no prompts, no separate profiles.

## Installation

```bash
npx @different-ai/opencode-browser install
```

The installer will:
1. Copy the extension to `~/.opencode-browser/extension/`
2. Guide you to load the extension in Chrome
3. Update your `opencode.json` with MCP server config

## Configuration

Add to your `opencode.json`:

```json
{
  "mcp": {
    "browser": {
      "type": "local",
      "command": ["bunx", "@different-ai/opencode-browser", "serve"]
    }
  }
}
```

Then load the extension in Chrome:
1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select `~/.opencode-browser/extension/`

## Available Tools

| Tool | Description |
|------|-------------|
| `browser_status` | Check if browser extension is connected |
| `browser_navigate` | Navigate to a URL |
| `browser_click` | Click an element by CSS selector |
| `browser_type` | Type text into an input field |
| `browser_screenshot` | Capture the page (returns base64, optionally saves to file) |
| `browser_snapshot` | Get accessibility tree with selectors + all page links |
| `browser_get_tabs` | List all open tabs |
| `browser_scroll` | Scroll page or element into view |
| `browser_wait` | Wait for a duration |
| `browser_execute` | Run JavaScript in page context |

### Screenshot Tool

The `browser_screenshot` tool returns base64 image data by default, allowing AI to view images directly:

```javascript
// Returns base64 image (AI can view it)
browser_screenshot()

// Save to current working directory
browser_screenshot({ save: true })

// Save to specific path
browser_screenshot({ path: "my-screenshot.png" })
```

## Architecture

```
OpenCode <──STDIO──> MCP Server <──WebSocket:19222──> Chrome Extension
                          │                                   │
                          └── @modelcontextprotocol/sdk       └── chrome.tabs, chrome.scripting
```

**Two components:**
1. MCP Server (runs as separate process, manages WebSocket server)
2. Chrome extension (connects to server, executes browser commands)

**Benefits of MCP architecture:**
- No session conflicts between OpenCode instances
- Server runs independently of OpenCode process
- Clean separation of concerns
- Standard MCP protocol

## Upgrading from v2.x (Plugin)

v3.0 migrates from plugin to MCP architecture:

1. Run `npx @different-ai/opencode-browser install`
2. Replace plugin config with MCP config in `opencode.json`:

```diff
- "plugin": ["@different-ai/opencode-browser"]
+ "mcp": {
+   "browser": {
+     "type": "local",
+     "command": ["bunx", "@different-ai/opencode-browser", "serve"]
+   }
+ }
```

3. Restart OpenCode

## Troubleshooting

**"Chrome extension not connected"**
- Make sure Chrome is running
- Check that the extension is loaded and enabled
- Click the extension icon to see connection status

**"Failed to start WebSocket server"**
- Port 19222 may be in use
- Run `lsof -i :19222` to check what's using it

**"browser_execute fails on some sites"**
- Sites with strict CSP block JavaScript execution
- Use `browser_snapshot` to get page data instead

## Uninstall

```bash
npx @different-ai/opencode-browser uninstall
```

Then remove the extension from Chrome and delete `~/.opencode-browser/` if desired.

## Platform Support

- macOS ✓
- Linux ✓  
- Windows (not yet supported)

## License

MIT

## Credits

Inspired by [Claude in Chrome](https://www.anthropic.com/news/claude-in-chrome) by Anthropic.
