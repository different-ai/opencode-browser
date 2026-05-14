# PRD - OpenCode Browser Direct CDP

## Summary

OpenCode Browser should provide a small, predictable browser automation toolset that connects directly to Chrome DevTools Protocol endpoints. The user or agent supplies `browser_url` on each call and optionally supplies `target_id` for a specific tab/window.

## Problem

- Extension/native-host/broker setup creates installation friction and hidden state.
- Per-session tab ownership makes behavior harder to predict across agents and terminals.
- The OpenWork browser example already proves a simpler direct-CDP model is sufficient for core automation.

## Goals

1. Match the OpenWork browser example behavior.
2. Require explicit `browser_url` values instead of implicit browser discovery.
3. Support multi-target browsing with `target_id`.
4. Keep the package lightweight and dependency-minimal.
5. Preserve a CLI path for listing tools and smoke-testing CDP connectivity.

## Non-Goals

- Shipping a Chrome extension.
- Managing native messaging hosts.
- Maintaining per-tab ownership claims.
- Preserving the old agent-browser backend.

## Tool Surface

- `browser_list`: list page targets on a CDP endpoint.
- `browser_navigate`: navigate a target to a URL.
- `browser_snapshot`: return an accessibility tree with UIDs.
- `browser_click`: click an element by UID from the latest snapshot.
- `browser_fill`: fill an input by UID from the latest snapshot.
- `browser_eval`: evaluate JavaScript in the page.
- `browser_screenshot`: capture a PNG screenshot and return its saved path.

## User Flow

1. Start Chrome, Chromium, or Electron with remote debugging enabled.
2. Call `browser_list({ browser_url })` to inspect targets.
3. Call `browser_navigate({ browser_url, target_id, url })` when navigation is needed.
4. Call `browser_snapshot({ browser_url, target_id })` to obtain UIDs.
5. Call `browser_click` or `browser_fill` using a UID from the cached snapshot.
6. Confirm with `browser_snapshot` or `browser_eval`.

## Risks

- CDP must be enabled by the browser owner.
- Snapshot UID caching is process-local and keyed by `browser_url` plus `target_id`.
- Some pages may hide interactive content from the accessibility tree; those cases should be handled with targeted future primitives.
