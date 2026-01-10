# Goal

Make browser automation predictable without relying on unsafe JavaScript eval, so visible on‑screen content (like verification tokens) is accessible via generic, reusable primitives.

## What I changed

- Added resilient DOM access primitives to the extension: deep query across shadow DOM + same‑origin iframes, indexed click/type, and text extraction via `browser_query`, `browser_wait_for`, and `browser_extract`.
- Expanded `browser_snapshot` to include visible text and richer node metadata so on‑screen strings are observable without eval.
- Marked `browser_execute` as legacy/JSON‑only to avoid CSP/unsafe‑eval failures.
- Updated plugin surface and README tool list to expose the new primitives.

## Why

- Native messaging and the broker make transport predictable, but they do not bypass CSP.
- Relying on `eval` breaks on strict pages (e.g., Google Admin Console), so we need stable, declarative primitives that mimic user‑visible access.

## Remaining tasks (if any)

- Validate the new primitives on the real Admin Console flow to confirm the verification token is visible via `browser_extract` or `browser_query`.
- Consider adding higher‑level “copy button” helpers only if real‑world flows still fail.

## Notes

- All changes are generic (no Google‑specific logic).
- `browser_execute` still exists for compatibility but now requires JSON commands.
