import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import net from "net";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_JSON_PATH = join(__dirname, "..", "package.json");

let cachedVersion: string | null = null;

function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    if (typeof pkg?.version === "string") {
      cachedVersion = pkg.version;
      return cachedVersion;
    }
  } catch {
    // ignore
  }
  cachedVersion = "unknown";
  return cachedVersion;
}

const BASE_DIR = join(homedir(), ".opencode-browser");
const SOCKET_PATH = join(BASE_DIR, "broker.sock");

mkdirSync(BASE_DIR, { recursive: true });

type BrokerResponse =
  | { type: "response"; id: number; ok: true; data: any }
  | { type: "response"; id: number; ok: false; error: string };

function createJsonLineParser(onMessage: (msg: any) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // ignore
      }
    }
  };
}

function writeJsonLine(socket: net.Socket, msg: any): void {
  socket.write(JSON.stringify(msg) + "\n");
}

function maybeStartBroker(): void {
  const brokerPath = join(BASE_DIR, "broker.cjs");
  if (!existsSync(brokerPath)) return;

  try {
    const child = spawn(process.execPath, [brokerPath], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // ignore
  }
}

async function connectToBroker(): Promise<net.Socket> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => reject(err));
  });
}

async function sleep(ms: number): Promise<void> {
  return await new Promise((r) => setTimeout(r, ms));
}

let socket: net.Socket | null = null;
let sessionId = Math.random().toString(36).slice(2);
let reqId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

async function ensureBrokerSocket(): Promise<net.Socket> {
  if (socket && !socket.destroyed) return socket;

  // Try to connect; if missing, try to start broker and retry.
  try {
    socket = await connectToBroker();
  } catch {
    maybeStartBroker();
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      try {
        socket = await connectToBroker();
        break;
      } catch {}
    }
  }

  if (!socket || socket.destroyed) {
    throw new Error(
      "Could not connect to local broker. Run `npx @different-ai/opencode-browser install` and ensure the extension is loaded."
    );
  }

  socket.setNoDelay(true);
  socket.on(
    "data",
    createJsonLineParser((msg) => {
      if (msg?.type !== "response" || typeof msg.id !== "number") return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      const res = msg as BrokerResponse;
      if (!res.ok) p.reject(new Error(res.error));
      else p.resolve(res.data);
    })
  );

  socket.on("close", () => {
    socket = null;
  });

  socket.on("error", () => {
    socket = null;
  });

  writeJsonLine(socket, { type: "hello", role: "plugin", sessionId, pid: process.pid });

  return socket;
}

async function brokerRequest(op: string, payload: Record<string, any>): Promise<any> {
  const s = await ensureBrokerSocket();
  const id = ++reqId;

  return await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    writeJsonLine(s, { type: "request", id, op, ...payload });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error("Timed out waiting for broker response"));
    }, 60000);
  });
}

function toolResultText(data: any, fallback: string): string {
  if (typeof data?.content === "string") return data.content;
  if (typeof data === "string") return data;
  if (data?.content != null) return JSON.stringify(data.content);
  return fallback;
}

const plugin: Plugin = {
  name: "opencode-browser",
  tools: [

    tool(
      "browser_status",
      "Check broker/native-host connection status and current tab claims.",
      {},
      async () => {
        const data = await brokerRequest("status", {});
        return JSON.stringify(data);
      }
    ),

    tool(
      "browser_get_tabs",
      "List all open browser tabs",
      {},
      async () => {
        const data = await brokerRequest("tool", { tool: "get_tabs", args: {} });
        return toolResultText(data, "ok");
      }
    ),
    tool(
      "browser_navigate",
      "Navigate to a URL in the browser",
      { url: { type: "string" }, tabId: { type: "number", optional: true } },
      async ({ url, tabId }: any) => {
        const data = await brokerRequest("tool", { tool: "navigate", args: { url, tabId } });
        return toolResultText(data, `Navigated to ${url}`);
      }
    ),
    tool(
      "browser_click",
      "Click an element on the page using a CSS selector",
      { selector: { type: "string" }, tabId: { type: "number", optional: true } },
      async ({ selector, tabId }: any) => {
        const data = await brokerRequest("tool", { tool: "click", args: { selector, tabId } });
        return toolResultText(data, `Clicked ${selector}`);
      }
    ),
    tool(
      "browser_type",
      "Type text into an input element",
      {
        selector: { type: "string" },
        text: { type: "string" },
        clear: { type: "boolean", optional: true },
        tabId: { type: "number", optional: true },
      },
      async ({ selector, text, clear, tabId }: any) => {
        const data = await brokerRequest("tool", { tool: "type", args: { selector, text, clear, tabId } });
        return toolResultText(data, `Typed \"${text}\" into ${selector}`);
      }
    ),
    tool(
      "browser_screenshot",
      "Take a screenshot of the current page. Returns base64 image data URL.",
      { tabId: { type: "number", optional: true } },
      async ({ tabId }: any) => {
        const data = await brokerRequest("tool", { tool: "screenshot", args: { tabId } });
        return toolResultText(data, "Screenshot failed");
      }
    ),
    tool(
      "browser_snapshot",
      "Get an accessibility tree snapshot of the page.",
      { tabId: { type: "number", optional: true } },
      async ({ tabId }: any) => {
        const data = await brokerRequest("tool", { tool: "snapshot", args: { tabId } });
        return toolResultText(data, "Snapshot failed");
      }
    ),
    tool(
      "browser_scroll",
      "Scroll the page or scroll an element into view",
      {
        selector: { type: "string", optional: true },
        x: { type: "number", optional: true },
        y: { type: "number", optional: true },
        tabId: { type: "number", optional: true },
      },
      async ({ selector, x, y, tabId }: any) => {
        const data = await brokerRequest("tool", { tool: "scroll", args: { selector, x, y, tabId } });
        return toolResultText(data, "Scrolled");
      }
    ),
    tool(
      "browser_wait",
      "Wait for a specified duration",
      { ms: { type: "number", optional: true }, tabId: { type: "number", optional: true } },
      async ({ ms, tabId }: any) => {
        const data = await brokerRequest("tool", { tool: "wait", args: { ms, tabId } });
        return toolResultText(data, "Waited");
      }
    ),
    tool(
      "browser_execute",
      "Execute JavaScript code in the page context and return the result.",
      { code: { type: "string" }, tabId: { type: "number", optional: true } },
      async ({ code, tabId }: any) => {
        const data = await brokerRequest("tool", { tool: "execute_script", args: { code, tabId } });
        return toolResultText(data, "Execute failed");
      }
    ),
    tool(
      "browser_claim_tab",
      "Claim a tab for this OpenCode session (per-tab ownership).",
      { tabId: { type: "number" }, force: { type: "boolean", optional: true } },
      async ({ tabId, force }: any) => {
        const data = await brokerRequest("claim_tab", { tabId, force });
        return JSON.stringify(data);
      }
    ),
    tool(
      "browser_release_tab",
      "Release a previously claimed tab.",
      { tabId: { type: "number" } },
      async ({ tabId }: any) => {
        const data = await brokerRequest("release_tab", { tabId });
        return JSON.stringify(data);
      }
    ),
    tool(
      "browser_list_claims",
      "List current tab ownership claims.",
      {},
      async () => {
        const data = await brokerRequest("list_claims", {});
        return JSON.stringify(data);
      }
    ),
  ],
};

export default plugin;
