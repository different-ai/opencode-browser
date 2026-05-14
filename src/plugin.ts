/**
 * Browser control tools: direct CDP, no extension, no MCP, multi-target.
 *
 * Every tool takes a `browser_url` like `http://127.0.0.1:9222` and
 * optionally a `target_id`. Start Chrome/Electron with remote debugging
 * enabled, then use `browser_list` to discover available page targets.
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { connectFirstPage, connectTarget, listTargets } from "./lib/cdp.js";
import { resolveUid, takeSnapshot, type Snapshot } from "./lib/snapshot.js";

const snapshotCache = new Map<string, Snapshot>();

function cacheKey(browserUrl: string, targetId?: string): string {
  return `${browserUrl}::${targetId ?? "default"}`;
}

async function getClient(browserUrl: string, targetId?: string) {
  if (targetId) {
    const targets = await listTargets(browserUrl);
    const target = targets.find((t) => t.id === targetId);
    if (!target) throw new Error(`Target ${targetId} not found`);
    return { client: await connectTarget(target.webSocketDebuggerUrl), target };
  }
  return connectFirstPage(browserUrl);
}

const plugin: Plugin = async () => {
  return {
    tool: {
      browser_list: tool({
        description:
          "List page targets on a Chrome/Electron CDP endpoint. Returns target IDs, titles, and URLs.",
        args: {
          browser_url: tool.schema
            .string()
            .describe('CDP HTTP endpoint, e.g. "http://127.0.0.1:9222"'),
        },
        async execute(args) {
          const targets = await listTargets(args.browser_url);
          const pages = targets.filter((t) => t.type === "page");
          if (pages.length === 0) return "No page targets found.";
          return pages.map((t) => `[${t.id}] ${t.title}\n  ${t.url}`).join("\n\n");
        },
      }),

      browser_navigate: tool({
        description: "Navigate a browser target to a URL and return the resulting page title.",
        args: {
          browser_url: tool.schema.string().describe("CDP HTTP endpoint"),
          target_id: tool.schema.string().optional().describe("Target ID. Omit for the first page target."),
          url: tool.schema.string().describe("URL to navigate to"),
        },
        async execute(args) {
          const { client } = await getClient(args.browser_url, args.target_id);
          try {
            await client.send("Page.enable");
            await client.send("Page.navigate", { url: args.url });
            await new Promise<void>((resolve) => {
              const timeout = setTimeout(resolve, 10000);
              client.on("Page.loadEventFired", () => {
                clearTimeout(timeout);
                resolve();
              });
            });
            const result = await client.send("Runtime.evaluate", {
              expression: "document.title",
              returnByValue: true,
            });
            const title = ((result.result as Record<string, unknown>)?.value as string | undefined) ?? "";
            return `Navigated to: ${args.url}\nTitle: ${title}`;
          } finally {
            client.close();
          }
        },
      }),

      browser_snapshot: tool({
        description:
          "Get an accessibility tree snapshot with [uid] markers. Use the UIDs with browser_click and browser_fill.",
        args: {
          browser_url: tool.schema.string().describe("CDP HTTP endpoint"),
          target_id: tool.schema.string().optional().describe("Target ID. Omit for the first page target."),
        },
        async execute(args) {
          const { client } = await getClient(args.browser_url, args.target_id);
          try {
            await client.send("Accessibility.enable");
            const snap = await takeSnapshot(client);
            snapshotCache.set(cacheKey(args.browser_url, args.target_id), snap);
            if (!snap.text || snap.text === "(empty page)") {
              const result = await client.send("Runtime.evaluate", {
                expression: "document.body?.innerText?.substring(0, 3000) ?? '(empty)'",
                returnByValue: true,
              });
              return `Page text:\n${(result.result as Record<string, unknown>)?.value ?? "(empty)"}`;
            }
            return snap.text;
          } finally {
            client.close();
          }
        },
      }),

      browser_click: tool({
        description: "Click an element identified by its snapshot UID. Call browser_snapshot first.",
        args: {
          browser_url: tool.schema.string().describe("CDP HTTP endpoint"),
          target_id: tool.schema.string().optional().describe("Target ID"),
          uid: tool.schema.number().describe("Element UID from browser_snapshot"),
        },
        async execute(args) {
          const snap = snapshotCache.get(cacheKey(args.browser_url, args.target_id));
          if (!snap) return "No snapshot cached. Call browser_snapshot first.";
          const node = resolveUid(snap, args.uid);
          if (!node) return `UID ${args.uid} not found in snapshot.`;

          const { client } = await getClient(args.browser_url, args.target_id);
          try {
            const resolved = await client.send("DOM.resolveNode", { backendNodeId: node.backendNodeId });
            const objectId = (resolved.object as Record<string, unknown>)?.objectId as string | undefined;
            if (!objectId) return `Could not resolve UID ${args.uid} to a DOM node.`;

            const box = await client.send("DOM.getBoxModel", { backendNodeId: node.backendNodeId });
            const model = box.model as Record<string, unknown> | undefined;
            const content = model?.content as number[] | undefined;

            if (content && content.length >= 8) {
              const x = (content[0] + content[2] + content[4] + content[6]) / 4;
              const y = (content[1] + content[3] + content[5] + content[7]) / 4;
              await client.send("Input.dispatchMouseEvent", {
                type: "mousePressed",
                x,
                y,
                button: "left",
                clickCount: 1,
              });
              await client.send("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                x,
                y,
                button: "left",
                clickCount: 1,
              });
              return `Clicked [${args.uid}] "${node.name}" at (${Math.round(x)}, ${Math.round(y)})`;
            }

            await client.send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: "function() { this.scrollIntoView({ block: 'center' }); this.click(); }",
            });
            return `Clicked [${args.uid}] "${node.name}" via JS fallback`;
          } finally {
            client.close();
          }
        },
      }),

      browser_fill: tool({
        description: "Fill an input element identified by its snapshot UID. Clears the existing value first.",
        args: {
          browser_url: tool.schema.string().describe("CDP HTTP endpoint"),
          target_id: tool.schema.string().optional().describe("Target ID"),
          uid: tool.schema.number().describe("Element UID from browser_snapshot"),
          value: tool.schema.string().describe("Text to fill"),
        },
        async execute(args) {
          const snap = snapshotCache.get(cacheKey(args.browser_url, args.target_id));
          if (!snap) return "No snapshot cached. Call browser_snapshot first.";
          const node = resolveUid(snap, args.uid);
          if (!node) return `UID ${args.uid} not found in snapshot.`;

          const { client } = await getClient(args.browser_url, args.target_id);
          try {
            const resolved = await client.send("DOM.resolveNode", { backendNodeId: node.backendNodeId });
            const objectId = (resolved.object as Record<string, unknown>)?.objectId as string | undefined;
            if (!objectId) return `Could not resolve UID ${args.uid}.`;

            await client.send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: `function() {
                this.focus();
                this.value = '';
                this.dispatchEvent(new Event('input', { bubbles: true }));
              }`,
            });

            for (const char of args.value) {
              await client.send("Input.dispatchKeyEvent", { type: "keyDown", text: char });
              await client.send("Input.dispatchKeyEvent", { type: "keyUp", text: char });
            }

            return `Filled [${args.uid}] "${node.name}" with "${args.value}"`;
          } finally {
            client.close();
          }
        },
      }),

      browser_eval: tool({
        description: "Evaluate a JavaScript expression in the page and return the result.",
        args: {
          browser_url: tool.schema.string().describe("CDP HTTP endpoint"),
          target_id: tool.schema.string().optional().describe("Target ID"),
          expression: tool.schema.string().describe("JavaScript expression to evaluate"),
        },
        async execute(args) {
          const { client } = await getClient(args.browser_url, args.target_id);
          try {
            const result = await client.send("Runtime.evaluate", {
              expression: args.expression,
              returnByValue: true,
              awaitPromise: true,
            });
            if (result.exceptionDetails) {
              const err = result.exceptionDetails as Record<string, unknown>;
              return `Error: ${err.text ?? JSON.stringify(err)}`;
            }
            const val = (result.result as Record<string, unknown>)?.value;
            if (val === undefined) return "(undefined)";
            return typeof val === "string" ? val : JSON.stringify(val, null, 2);
          } finally {
            client.close();
          }
        },
      }),

      browser_screenshot: tool({
        description: "Take a PNG screenshot of the page and return the saved file path.",
        args: {
          browser_url: tool.schema.string().describe("CDP HTTP endpoint"),
          target_id: tool.schema.string().optional().describe("Target ID"),
        },
        async execute(args) {
          const { client } = await getClient(args.browser_url, args.target_id);
          try {
            const result = await client.send("Page.captureScreenshot", { format: "png" });
            const data = result.data as string | undefined;
            if (!data) return "Failed to capture screenshot.";
            const path = join(tmpdir(), `browser-screenshot-${Date.now()}.png`);
            writeFileSync(path, Buffer.from(data, "base64"));
            return `Screenshot saved: ${path}\n(${Math.round((data.length * 0.75) / 1024)} KB)`;
          } finally {
            client.close();
          }
        },
      }),
    },
  };
};

export default plugin;
