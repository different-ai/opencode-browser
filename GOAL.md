# Goal

Make OpenCode Browser behave like the OpenWork browser tool example: direct CDP control with explicit browser endpoints and target IDs.

## What Changed

- Replaced the extension/native-host/broker backend with a direct CDP plugin implementation.
- Added minimal CDP and accessibility snapshot helpers under `src/lib/`.
- Exposed the example-compatible tools: `browser_list`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_eval`, and `browser_screenshot`.
- Removed bundled agent-browser, Chrome Web Store, extension, native host, and broker artifacts.
- Updated README, CLI, lockfiles, and skill guidance for explicit `browser_url` usage.

## Why

- The direct CDP model is easier to reason about and avoids hidden singleton browser state.
- Explicit `browser_url` values make local, Electron, and remote browser targets predictable.
- Snapshot UIDs provide a simple action workflow without maintaining selector-specific browser APIs.

## Remaining Tasks

- Run a live browser smoke test once a CDP endpoint is available.
- Consider adding more CDP primitives only when concrete workflows need them.
