#!/usr/bin/env node
/**
 * OpenCode Browser MCP Server
 *
 * MCP Server <--STDIO--> OpenCode
 * MCP Server <--WebSocket:19222--> Chrome Extension
 *
 * This is a standalone MCP server that manages browser automation.
 * It runs as a separate process and communicates with OpenCode via STDIO.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const WS_PORT = 19222;
const BASE_DIR = join(homedir(), ".opencode-browser");

mkdirSync(BASE_DIR, { recursive: true });

// WebSocket state for Chrome extension connection
let ws: any = null;
let isConnected = false;
let server: ReturnType<typeof Bun.serve> | null = null;
let pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let requestId = 0;

// Create MCP server
const mcpServer = new McpServer({
  name: "opencode-browser",
  version: "2.1.0",
});

// ============================================================================
// WebSocket Server for Chrome Extension
// ============================================================================

function handleMessage(message: { type: string; id?: number; result?: any; error?: any }): void {
  if (message.type === "tool_response" && message.id !== undefined) {
    const pending = pendingRequests.get(message.id);
    if (!pending) return;

    pendingRequests.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.content || String(message.error)));
    } else {
      pending.resolve(message.result?.content);
    }
  }
}

function sendToChrome(message: any): boolean {
  if (ws && isConnected) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

async function isPortFree(port: number): Promise<boolean> {
  try {
    const testSocket = await Bun.connect({
      hostname: "localhost",
      port,
      socket: {
        data() {},
        open(socket) {
          socket.end();
        },
        close() {},
        error() {},
      },
    });
    testSocket.end();
    return false;
  } catch (e: any) {
    if (e.code === "ECONNREFUSED" || e.message?.includes("ECONNREFUSED")) {
      return true;
    }
    return true;
  }
}

async function killProcessOnPort(port: number): Promise<boolean> {
  try {
    // Use lsof to find PID using the port
    const proc = Bun.spawn(["lsof", "-t", `-i:${port}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const pids = output.trim().split("\n").filter(Boolean);
    
    if (pids.length === 0) {
      return true; // No process found, port should be free
    }

    // Kill each PID found
    for (const pid of pids) {
      const pidNum = parseInt(pid, 10);
      if (isNaN(pidNum)) continue;
      
      console.error(`[browser-mcp] Killing existing process ${pidNum} on port ${port}`);
      try {
        process.kill(pidNum, "SIGTERM");
      } catch (e) {
        // Process may have already exited
      }
    }

    // Wait a bit for process to die
    await sleep(500);
    
    // Verify port is now free
    return await isPortFree(port);
  } catch (e) {
    console.error(`[browser-mcp] Failed to kill process on port:`, e);
    return false;
  }
}

async function startWebSocketServer(): Promise<boolean> {
  if (server) return true;
  
  if (!(await isPortFree(WS_PORT))) {
    console.error(`[browser-mcp] Port ${WS_PORT} is in use, attempting to take over...`);
    const killed = await killProcessOnPort(WS_PORT);
    if (!killed) {
      console.error(`[browser-mcp] Failed to free port ${WS_PORT}`);
      return false;
    }
    console.error(`[browser-mcp] Successfully freed port ${WS_PORT}`);
  }

  try {
    server = Bun.serve({
      port: WS_PORT,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("OpenCode Browser MCP Server", { status: 200 });
      },
      websocket: {
        open(wsClient) {
          console.error(`[browser-mcp] Chrome extension connected`);
          ws = wsClient;
          isConnected = true;
        },
        close() {
          console.error(`[browser-mcp] Chrome extension disconnected`);
          ws = null;
          isConnected = false;
        },
        message(_wsClient, data) {
          try {
            const message = JSON.parse(data.toString());
            handleMessage(message);
          } catch (e) {
            console.error(`[browser-mcp] Parse error:`, e);
          }
        },
      },
    });

    console.error(`[browser-mcp] WebSocket server listening on port ${WS_PORT}`);
    return true;
  } catch (e) {
    console.error(`[browser-mcp] Failed to start WebSocket server:`, e);
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExtensionConnection(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isConnected) return true;
    await sleep(100);
  }
  return isConnected;
}

async function ensureConnection(): Promise<void> {
  if (!server) {
    const started = await startWebSocketServer();
    if (!started) {
      throw new Error("Failed to start WebSocket server. Port may be in use.");
    }
  }

  if (!isConnected) {
    const connected = await waitForExtensionConnection(5000);
    if (!connected) {
      throw new Error(
        "Chrome extension not connected. Make sure Chrome is running with the OpenCode Browser extension enabled."
      );
    }
  }
}

async function executeCommand(toolName: string, args: Record<string, any>): Promise<any> {
  await ensureConnection();

  const id = ++requestId;

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });

    sendToChrome({
      type: "tool_request",
      id,
      tool: toolName,
      args,
    });

    setTimeout(() => {
      if (!pendingRequests.has(id)) return;
      pendingRequests.delete(id);
      reject(new Error("Tool execution timed out after 60 seconds"));
    }, 60000);
  });
}

// ============================================================================
// Register MCP Tools
// ============================================================================

mcpServer.tool(
  "browser_status",
  "Check if browser extension is connected. Returns connection status.",
  {},
  async () => {
    const status = isConnected
      ? "Browser extension connected and ready."
      : "Browser extension not connected. Make sure Chrome is running with the OpenCode Browser extension enabled.";

    return {
      content: [{ type: "text", text: status }],
    };
  }
);

mcpServer.tool(
  "browser_navigate",
  "Navigate to a URL in the browser",
  {
    url: z.string().describe("The URL to navigate to"),
    tabId: z.number().optional().describe("Optional tab ID to navigate in"),
  },
  async ({ url, tabId }) => {
    const result = await executeCommand("navigate", { url, tabId });
    return {
      content: [{ type: "text", text: result || `Navigated to ${url}` }],
    };
  }
);

mcpServer.tool(
  "browser_click",
  "Click an element on the page using a CSS selector",
  {
    selector: z.string().describe("CSS selector for element to click"),
    tabId: z.number().optional().describe("Optional tab ID"),
  },
  async ({ selector, tabId }) => {
    const result = await executeCommand("click", { selector, tabId });
    return {
      content: [{ type: "text", text: result || `Clicked ${selector}` }],
    };
  }
);

mcpServer.tool(
  "browser_type",
  "Type text into an input element",
  {
    selector: z.string().describe("CSS selector for input element"),
    text: z.string().describe("Text to type"),
    clear: z.boolean().optional().describe("Clear field before typing"),
    tabId: z.number().optional().describe("Optional tab ID"),
  },
  async ({ selector, text, clear, tabId }) => {
    const result = await executeCommand("type", { selector, text, clear, tabId });
    return {
      content: [{ type: "text", text: result || `Typed "${text}" into ${selector}` }],
    };
  }
);

mcpServer.tool(
  "browser_screenshot",
  "Take a screenshot of the current page. Returns base64 image data that can be viewed directly. Optionally saves to a file.",
  {
    tabId: z.number().optional().describe("Optional tab ID"),
    save: z.boolean().optional().describe("Save to file (default: false, just returns base64)"),
    path: z.string().optional().describe("Custom file path to save screenshot (implies save=true). Defaults to cwd if just save=true"),
  },
  async ({ tabId, save, path: savePath }) => {
    const result = await executeCommand("screenshot", { tabId });

    if (result && typeof result === "string" && result.startsWith("data:image")) {
      const base64Data = result.replace(/^data:image\/\w+;base64,/, "");
      
      const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
        {
          type: "image",
          data: base64Data,
          mimeType: "image/png",
        },
      ];

      // Optionally save to file
      if (save || savePath) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        let filepath: string;
        
        if (savePath) {
          // Use provided path (add .png if no extension)
          filepath = savePath.endsWith(".png") ? savePath : `${savePath}.png`;
          // If relative path, resolve from cwd
          if (!savePath.startsWith("/")) {
            filepath = join(process.cwd(), filepath);
          }
        } else {
          // Default to cwd with timestamp
          filepath = join(process.cwd(), `screenshot-${timestamp}.png`);
        }

        writeFileSync(filepath, Buffer.from(base64Data, "base64"));
        content.push({ type: "text", text: `Saved: ${filepath}` });
      }

      return { content };
    }

    return {
      content: [{ type: "text", text: result || "Screenshot failed" }],
    };
  }
);

mcpServer.tool(
  "browser_snapshot",
  "Get an accessibility tree snapshot of the page. Returns interactive elements with selectors for clicking, plus all links on the page.",
  {
    tabId: z.number().optional().describe("Optional tab ID"),
  },
  async ({ tabId }) => {
    const result = await executeCommand("snapshot", { tabId });
    return {
      content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
    };
  }
);

mcpServer.tool(
  "browser_get_tabs",
  "List all open browser tabs",
  {},
  async () => {
    const result = await executeCommand("get_tabs", {});
    return {
      content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
    };
  }
);

mcpServer.tool(
  "browser_scroll",
  "Scroll the page or scroll an element into view",
  {
    selector: z.string().optional().describe("CSS selector to scroll into view"),
    x: z.number().optional().describe("Horizontal scroll amount in pixels"),
    y: z.number().optional().describe("Vertical scroll amount in pixels"),
    tabId: z.number().optional().describe("Optional tab ID"),
  },
  async ({ selector, x, y, tabId }) => {
    const result = await executeCommand("scroll", { selector, x, y, tabId });
    return {
      content: [{ type: "text", text: result || `Scrolled ${selector ? `to ${selector}` : `by (${x || 0}, ${y || 0})`}` }],
    };
  }
);

mcpServer.tool(
  "browser_wait",
  "Wait for a specified duration",
  {
    ms: z.number().optional().describe("Milliseconds to wait (default: 1000)"),
  },
  async ({ ms }) => {
    const waitMs = ms || 1000;
    const result = await executeCommand("wait", { ms: waitMs });
    return {
      content: [{ type: "text", text: result || `Waited ${waitMs}ms` }],
    };
  }
);

mcpServer.tool(
  "browser_execute",
  "Execute JavaScript code in the page context and return the result. Note: May fail on pages with strict CSP.",
  {
    code: z.string().describe("JavaScript code to execute"),
    tabId: z.number().optional().describe("Optional tab ID"),
  },
  async ({ code, tabId }) => {
    const result = await executeCommand("execute_script", { code, tabId });
    return {
      content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
    };
  }
);

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.error("[browser-mcp] Starting OpenCode Browser MCP Server...");

  // Start WebSocket server for Chrome extension
  await startWebSocketServer();

  // Connect MCP server to STDIO transport
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error("[browser-mcp] MCP Server running on STDIO");
}

main().catch((error) => {
  console.error("[browser-mcp] Fatal error:", error);
  process.exit(1);
});
