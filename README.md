# OpenCode Browser

Browser automation plugin for [OpenCode](https://github.com/opencode-ai/opencode).

Control your real Chrome browser with existing logins, cookies, and bookmarks. No DevTools Protocol, no security prompts.

## Why?

Chrome 136+ blocks `--remote-debugging-port` on your default profile for security reasons. DevTools-based automation (like Playwright) triggers a security prompt every time.

OpenCode Browser uses a simple WebSocket connection between an OpenCode plugin and a Chrome extension. Your automation works with your existing browser session - no prompts, no separate profiles.

## Installation

```bash
npx @different-ai/opencode-browser install
```

The installer will:
1. Copy the extension to `~/.opencode-browser/extension/`
2. Guide you to load the extension in Chrome
3. Update your `opencode.json` to use the plugin

## Configuration

Add to your `opencode.json`:

```json
{
  "plugin": ["@different-ai/opencode-browser"]
}
```

Then load the extension in Chrome:
1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select `~/.opencode-browser/extension/`

## Available Tools

| Tool | Description |
|------|-------------|
| `browser_status` | Check if browser is available or locked |
| `browser_kill_session` | Take over from another OpenCode session |
| `browser_navigate` | Navigate to a URL |
| `browser_click` | Click an element by CSS selector |
| `browser_type` | Type text into an input field |
| `browser_screenshot` | Capture the visible page |
| `browser_snapshot` | Get accessibility tree with selectors |
| `browser_get_tabs` | List all open tabs |
| `browser_scroll` | Scroll page or element into view |
| `browser_wait` | Wait for a duration |
| `browser_execute` | Run JavaScript in page context |

## Multi-Session Support

Only one OpenCode session can use the browser at a time. This prevents conflicts when you have multiple terminals open.

- `browser_status` - Check who has the lock
- `browser_kill_session` - Kill the other session and take over

In your prompts, you can say:
- "If browser is locked, kill the session and proceed"
- "If browser is locked, skip this task"

## Architecture

```
OpenCode Plugin ◄──WebSocket:19222──► Chrome Extension
       │                                    │
       └── Lock file                        └── chrome.tabs, chrome.scripting
```

**Two components:**
1. OpenCode plugin (runs WebSocket server, defines tools)
2. Chrome extension (connects to plugin, executes commands)

**No daemon. No MCP server. No native messaging host.**

## Upgrading from v1.x

v2.0 is a complete rewrite with a simpler architecture:

1. Run `npx @different-ai/opencode-browser install` (cleans up old daemon automatically)
2. Replace MCP config with plugin config in `opencode.json`:

```diff
- "mcp": {
-   "browser": {
-     "type": "local",
-     "command": ["npx", "@different-ai/opencode-browser", "start"],
-     "enabled": true
-   }
- }
+ "plugin": ["@different-ai/opencode-browser"]
```

3. Restart OpenCode

## Troubleshooting

**"Chrome extension not connected"**
- Make sure Chrome is running
- Check that the extension is loaded and enabled
- Click the extension icon to see connection status

**"Browser locked by another session"**
- Use `browser_kill_session` to take over
- Or close the other OpenCode session

**"Failed to start WebSocket server"**
- Port 19222 may be in use
- Check if another OpenCode session is running

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
