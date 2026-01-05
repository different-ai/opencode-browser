/**
 * OpenCode Browser Plugin
 *
 * A simple plugin that provides browser automation tools.
 * Connects to Chrome extension via WebSocket.
 *
 * Architecture:
 *   OpenCode Plugin (this) <--WebSocket:19222--> Chrome Extension
 *
 * Lock file ensures only one OpenCode session uses browser at a time.
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const WS_PORT = 19222;
const BASE_DIR = join(homedir(), ".opencode-browser");
const LOCK_FILE = join(BASE_DIR, "lock.json");
const SCREENSHOTS_DIR = join(BASE_DIR, "screenshots");

// Ensure directories exist
mkdirSync(BASE_DIR, { recursive: true });
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// Session state
const sessionId = Math.random().toString(36).slice(2);
const pid = process.pid;
let ws: WebSocket | null = null;
let isConnected = false;
let server: ReturnType<typeof Bun.serve> | null = null;
let pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let requestId = 0;
let hasLock = false;
let serverFailed = false;

// ============================================================================
// Lock File Management
// ============================================================================

interface LockInfo {
  pid: number;
  sessionId: string;
  startedAt: string;
  cwd: string;
}

function readLock(): LockInfo | null {
  try {
    if (!existsSync(LOCK_FILE)) return null;
    return JSON.parse(readFileSync(LOCK_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function writeLock(): void {
  writeFileSync(
    LOCK_FILE,
    JSON.stringify({
      pid,
      sessionId,
      startedAt: new Date().toISOString(),
      cwd: process.cwd(),
    } satisfies LockInfo)
  );
  hasLock = true;
}

function releaseLock(): void {
  try {
    const lock = readLock();
    if (lock && lock.sessionId === sessionId) {
      unlinkSync(LOCK_FILE);
    }
  } catch {}
  hasLock = false;
}

function isProcessAlive(targetPid: number): boolean {
  try {
    process.kill(targetPid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryAcquireLock(): { success: boolean; error?: string; lock?: LockInfo } {
  const existingLock = readLock();

  if (!existingLock) {
    writeLock();
    return { success: true };
  }

  if (existingLock.sessionId === sessionId) {
    return { success: true };
  }

  if (!isProcessAlive(existingLock.pid)) {
    // Stale lock, take it
    writeLock();
    return { success: true };
  }

  return {
    success: false,
    error: `Browser locked by another session (PID ${existingLock.pid})`,
    lock: existingLock,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killSession(targetPid: number): Promise<{ success: boolean; error?: string }> {
  try {
    process.kill(targetPid, "SIGTERM");
    // Wait for process to die
    let attempts = 0;
    while (isProcessAlive(targetPid) && attempts < 10) {
      await sleep(100);
      attempts++;
    }
    if (isProcessAlive(targetPid)) {
      process.kill(targetPid, "SIGKILL");
    }
    // Remove lock and acquire
    try { unlinkSync(LOCK_FILE); } catch {}
    writeLock();
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ============================================================================
// WebSocket Server
// ============================================================================

function checkPortAvailable(): boolean {
  try {
    const testSocket = Bun.connect({ port: WS_PORT, timeout: 1000 });
    testSocket.end();
    return true;
  } catch (e) {
    if ((e as any).code === "ECONNREFUSED") {
      return false;
    }
    return true;
  }
}

function startServer(): boolean {
  if (server) {
    console.error(`[browser-plugin] Server already running`);
    return true;
  }

  try {
    server = Bun.serve({
      port: WS_PORT,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("OpenCode Browser Plugin", { status: 200 });
      },
      websocket: {
        open(wsClient) {
          console.error(`[browser-plugin] Chrome extension connected`);
          ws = wsClient as unknown as WebSocket;
          isConnected = true;
        },
        close() {
          console.error(`[browser-plugin] Chrome extension disconnected`);
          ws = null;
          isConnected = false;
        },
        message(wsClient, data) {
          try {
            const message = JSON.parse(data.toString());
            handleMessage(message);
          } catch (e) {
            console.error(`[browser-plugin] Parse error:`, e);
          }
        },
      },
    });
    console.error(`[browser-plugin] WebSocket server listening on port ${WS_PORT}`);
    serverFailed = false;
    return true;
  } catch (e) {
    console.error(`[browser-plugin] Failed to start server:`, e);
    return false;
  }
}

function handleMessage(message: { type: string; id?: number; result?: any; error?: any }): void {
  if (message.type === "tool_response" && message.id !== undefined) {
    const pending = pendingRequests.get(message.id);
    if (pending) {
      pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.content || String(message.error)));
      } else {
        pending.resolve(message.result?.content);
      }
    }
  } else if (message.type === "pong") {
    // Heartbeat response, ignore
  }
}

function sendToChrome(message: any): boolean {
  if (ws && isConnected) {
    (ws as any).send(JSON.stringify(message));
    return true;
  }
  return false;
}

async function executeCommand(tool: string, args: Record<string, any>): Promise<any> {
  // Check lock and start server if needed
  const lockResult = tryAcquireLock();
  if (!lockResult.success) {
    throw new Error(
      `${lockResult.error}. Use browser_kill_session to take over, or browser_status to see details.`
    );
  }

  if (!server) {
    if (!startServer()) {
      throw new Error("Failed to start WebSocket server. Port may be in use.");
    }
  }

  if (!isConnected) {
    throw new Error(
      "Chrome extension not connected. Make sure Chrome is running with the OpenCode Browser extension enabled."
    );
  }

  const id = ++requestId;

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });

    sendToChrome({
      type: "tool_request",
      id,
      tool,
      args,
    });

    // Timeout after 60 seconds
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("Tool execution timed out after 60 seconds"));
      }
    }, 60000);
  });
}

// ============================================================================
// Cleanup on exit
// ============================================================================

process.on("SIGTERM", () => {
  releaseLock();
  server?.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  releaseLock();
  server?.stop();
  process.exit(0);
});

process.on("exit", () => {
  releaseLock();
});

// ============================================================================
// Plugin Export
// ============================================================================

export const BrowserPlugin: Plugin = async (ctx) => {
  console.error(`[browser-plugin] Initializing (session ${sessionId})`);

  // Check port availability on load, don't try to acquire lock yet
  checkPortAvailable();

  // Check lock status and set appropriate state
  const lock = readLock();
  if (!lock) {
    // No lock - just check if we can start server
    console.error(`[browser-plugin] No lock file, checking port...`);
    if (!startServer()) {
      serverFailed = true;
    }
  } else if (lock.sessionId === sessionId) {
    // We own the lock - start server
    console.error(`[browser-plugin] Already have lock, starting server...`);
    if (!startServer()) {
      serverFailed = true;
    }
  } else if (!isProcessAlive(lock.pid)) {
    // Stale lock - take it and start server
    console.error(`[browser-plugin] Stale lock from dead PID ${lock.pid}, taking over...`);
    writeLock();
    if (!startServer()) {
      serverFailed = true;
    }
  } else {
    // Another session has the lock
    console.error(`[browser-plugin] Lock held by PID ${lock.pid}, tools will fail until lock is released`);
  }

  return {
    tool: {
      browser_status: tool({
        description:
          "Check if browser is available or locked by another session. Returns connection status and lock info.",
        args: {},
        async execute() {
          const lock = readLock();

          if (!lock) {
            return "Browser available (no active session)";
          }

          if (lock.sessionId === sessionId) {
            return `Browser connected (this session)\nPID: ${pid}\nStarted: ${lock.startedAt}\nExtension: ${isConnected ? "connected" : "not connected"}`;
          }

          if (!isProcessAlive(lock.pid)) {
            return `Browser available (stale lock from dead PID ${lock.pid} will be auto-cleaned)`;
          }

          return `Browser locked by another session\nPID: ${lock.pid}\nSession: ${lock.sessionId}\nStarted: ${lock.startedAt}\nWorking directory: ${lock.cwd}\n\nUse browser_kill_session to take over.`;
        },
      }),

      browser_kill_session: tool({
        description:
          "Kill the session that currently holds the browser lock and take over. Use when browser_status shows another session has the lock.",
        args: {},
        async execute() {
          const lock = readLock();

          if (!lock) {
            // No lock, just acquire
            writeLock();
            // Start server if needed
            if (!server) {
              if (!startServer()) {
                throw new Error("Failed to start WebSocket server after acquiring lock.");
              }
            }
            return "No active session. Browser now connected to this session.";
          }

          if (lock.sessionId === sessionId) {
            return "This session already owns the browser.";
          }

          if (!isProcessAlive(lock.pid)) {
            // Stale lock
            writeLock();
            // Start server if needed
            if (!server) {
              if (!startServer()) {
                throw new Error("Failed to start WebSocket server after cleaning stale lock.");
              }
            }
            return `Cleaned stale lock (PID ${lock.pid} was dead). Browser now connected to this session.`;
          }

          // Kill other session and wait for port to be free
          const result = await killSession(lock.pid);
          if (result.success) {
            if (!server) {
              if (!startServer()) {
                throw new Error("Failed to start WebSocket server after killing other session.");
              }
            }
            return `Killed session ${lock.sessionId} (PID ${lock.pid}). Browser now connected to this session.`;
          } else {
            throw new Error(`Failed to kill session: ${result.error}`);
          }
        },
      }),

      browser_navigate: tool({
        description: "Navigate to a URL in browser",
        args: {
          url: tool.schema.string({ description: "The URL to navigate to" }),
          tabId: tool.schema.optional(tool.schema.number({ description: "Optional tab ID" })),
        },
        async execute(args) {
          return await executeCommand("navigate", args);
        },
      }),

      browser_click: tool({
        description: "Click an element on page using a CSS selector",
        args: {
          selector: tool.schema.string({ description: "CSS selector for element to click" }),
          tabId: tool.schema.optional(tool.schema.number({ description: "Optional tab ID" })),
        },
        async execute(args) {
          return await executeCommand("click", args);
        },
      }),

      browser_type: tool({
        description: "Type text into an input element",
        args: {
          selector: tool.schema.string({ description: "CSS selector for input element" }),
          text: tool.schema.string({ description: "Text to type" }),
          clear: tool.schema.optional(tool.schema.boolean({ description: "Clear field before typing" })),
          tabId: tool.schema.optional(tool.schema.number({ description: "Optional tab ID" })),
        },
        async execute(args) {
          return await executeCommand("type", args);
        },
      }),

      browser_screenshot: tool({
        description: "Take a screenshot of the current page. Saves to ~/.opencode-browser/screenshots/",
        args: {
          tabId: tool.schema.optional(tool.schema.number({ description: "Optional tab ID" })),
          name: tool.schema.optional(
            tool.schema.string({ description: "Optional name for screenshot file (without extension)" })
          ),
        },
        async execute(args) {
          const result = await executeCommand("screenshot", args);

          if (result && result.startsWith("data:image")) {
            const base64Data = result.replace(/^data:image\/\w+;base64,/, "");
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const filename = args.name ? `${args.name}.png` : `screenshot-${timestamp}.png`;
            const filepath = join(SCREENSHOTS_DIR, filename);

            writeFileSync(filepath, Buffer.from(base64Data, "base64"));
            return `Screenshot saved: ${filepath}`;
          }

          return result;
        },
      }),

      browser_snapshot: tool({
        description:
          "Get an accessibility tree snapshot of the page. Returns interactive elements with selectors for clicking.",
        args: {
          tabId: tool.schema.optional(tool.schema.number({ description: "Optional tab ID" })),
        },
        async execute(args) {
          return await executeCommand("snapshot", args);
        },
      }),

      browser_get_tabs: tool({
        description: "List all open browser tabs",
        args: {},
        async execute() {
          return await executeCommand("get_tabs", {});
        },
      }),

      browser_scroll: tool({
        description: "Scroll the page or scroll an element into view",
        args: {
          selector: tool.schema.optional(tool.schema.string({ description: "CSS selector to scroll into view" })),
          x: tool.schema.optional(tool.schema.number({ description: "Horizontal scroll amount in pixels" })),
          y: tool.schema.optional(tool.schema.number({ description: "Vertical scroll amount in pixels" })),
          tabId: tool.schema.optional(tool.schema.number({ description: "Optional tab ID" })),
        },
        async execute(args) {
          return await executeCommand("scroll", args);
        },
      }),

      browser_wait: tool({
        description: "Wait for a specified duration",
        args: {
          ms: tool.schema.optional(tool.schema.number({ description: "Milliseconds to wait (default: 1000)" })),
        },
        async execute(args) {
          return await executeCommand("wait", args);
        },
      }),

      browser_execute: tool({
        description: "Execute JavaScript code in the page context and return the result",
        args: {
          code: tool.schema.string({ description: "JavaScript code to execute" }),
          tabId: tool.schema.optional(tool.schema.number({ description: "Optional tab ID" })),
        },
        async execute(args) {
          return await executeCommand("execute_script", args);
        },
      }),
    },
  };
};

export default BrowserPlugin;
