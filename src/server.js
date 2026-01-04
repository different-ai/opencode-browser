#!/usr/bin/env node
/**
 * MCP Server for Browser Automation
 * 
 * This server exposes browser automation tools to OpenCode via MCP.
 * It connects to the native messaging host via Unix socket to execute commands.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createConnection } from "net";
import { homedir } from "os";
import { join } from "path";

const SOCKET_PATH = join(homedir(), ".opencode-browser", "browser.sock");

// ============================================================================
// Socket Connection to Native Host
// ============================================================================

let socket = null;
let connected = false;
let pendingRequests = new Map();
let requestId = 0;
let buffer = "";

function connectToHost() {
  return new Promise((resolve, reject) => {
    socket = createConnection(SOCKET_PATH);
    
    socket.on("connect", () => {
      console.error("[browser-mcp] Connected to native host");
      connected = true;
      resolve();
    });
    
    socket.on("data", (data) => {
      buffer += data.toString();
      
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            handleHostMessage(message);
          } catch (e) {
            console.error("[browser-mcp] Failed to parse:", e.message);
          }
        }
      }
    });
    
    socket.on("close", () => {
      console.error("[browser-mcp] Disconnected from native host");
      connected = false;
      // Reject all pending requests
      for (const [id, { reject }] of pendingRequests) {
        reject(new Error("Connection closed"));
      }
      pendingRequests.clear();
    });
    
    socket.on("error", (err) => {
      console.error("[browser-mcp] Socket error:", err.message);
      if (!connected) {
        reject(err);
      }
    });
  });
}

function handleHostMessage(message) {
  if (message.type === "tool_response") {
    const pending = pendingRequests.get(message.id);
    if (pending) {
      pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.content));
      } else {
        pending.resolve(message.result.content);
      }
    }
  }
}

async function executeTool(tool, args) {
  if (!connected) {
    // Try to reconnect
    try {
      await connectToHost();
    } catch {
      throw new Error("Not connected to browser extension. Make sure Chrome is running with the OpenCode extension installed.");
    }
  }
  
  const id = ++requestId;
  
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    
    socket.write(JSON.stringify({
      type: "tool_request",
      id,
      tool,
      args
    }) + "\n");
    
    // Timeout after 60 seconds
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("Tool execution timed out"));
      }
    }, 60000);
  });
}

// ============================================================================
// MCP Server
// ============================================================================

const server = new Server(
  {
    name: "browser-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "browser_navigate",
        description: "Navigate to a URL in the browser",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to navigate to"
            },
            tabId: {
              type: "number",
              description: "Optional tab ID. Uses active tab if not specified."
            }
          },
          required: ["url"]
        }
      },
      {
        name: "browser_click",
        description: "Click an element on the page using a CSS selector",
        inputSchema: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector for the element to click"
            },
            tabId: {
              type: "number",
              description: "Optional tab ID"
            }
          },
          required: ["selector"]
        }
      },
      {
        name: "browser_type",
        description: "Type text into an input element",
        inputSchema: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector for the input element"
            },
            text: {
              type: "string",
              description: "Text to type"
            },
            clear: {
              type: "boolean",
              description: "Clear the field before typing"
            },
            tabId: {
              type: "number",
              description: "Optional tab ID"
            }
          },
          required: ["selector", "text"]
        }
      },
      {
        name: "browser_screenshot",
        description: "Take a screenshot of the current page",
        inputSchema: {
          type: "object",
          properties: {
            tabId: {
              type: "number",
              description: "Optional tab ID"
            },
            fullPage: {
              type: "boolean",
              description: "Capture full page (not yet implemented)"
            }
          }
        }
      },
      {
        name: "browser_snapshot",
        description: "Get an accessibility tree snapshot of the page. Returns interactive elements with selectors.",
        inputSchema: {
          type: "object",
          properties: {
            tabId: {
              type: "number",
              description: "Optional tab ID"
            }
          }
        }
      },
      {
        name: "browser_get_tabs",
        description: "List all open browser tabs",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "browser_scroll",
        description: "Scroll the page or scroll an element into view",
        inputSchema: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector to scroll into view"
            },
            x: {
              type: "number",
              description: "Horizontal scroll amount in pixels"
            },
            y: {
              type: "number",
              description: "Vertical scroll amount in pixels"
            },
            tabId: {
              type: "number",
              description: "Optional tab ID"
            }
          }
        }
      },
      {
        name: "browser_wait",
        description: "Wait for a specified duration",
        inputSchema: {
          type: "object",
          properties: {
            ms: {
              type: "number",
              description: "Milliseconds to wait (default: 1000)"
            }
          }
        }
      },
      {
        name: "browser_execute",
        description: "Execute JavaScript code in the page context",
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "JavaScript code to execute"
            },
            tabId: {
              type: "number",
              description: "Optional tab ID"
            }
          },
          required: ["code"]
        }
      }
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  // Map MCP tool names to internal tool names
  const toolMap = {
    browser_navigate: "navigate",
    browser_click: "click",
    browser_type: "type",
    browser_screenshot: "screenshot",
    browser_snapshot: "snapshot",
    browser_get_tabs: "get_tabs",
    browser_scroll: "scroll",
    browser_wait: "wait",
    browser_execute: "execute_script"
  };
  
  const internalTool = toolMap[name];
  if (!internalTool) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true
    };
  }
  
  try {
    const result = await executeTool(internalTool, args || {});
    
    // Handle screenshot specially - return as image
    if (internalTool === "screenshot" && result.startsWith("data:image")) {
      const base64Data = result.replace(/^data:image\/\w+;base64,/, "");
      return {
        content: [
          {
            type: "image",
            data: base64Data,
            mimeType: "image/png"
          }
        ]
      };
    }
    
    return {
      content: [{ type: "text", text: result }]
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true
    };
  }
});

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Try to connect to native host
  try {
    await connectToHost();
  } catch (error) {
    console.error("[browser-mcp] Warning: Could not connect to native host:", error.message);
    console.error("[browser-mcp] Will retry on first tool call");
  }
  
  // Start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[browser-mcp] MCP server started");
}

main().catch((error) => {
  console.error("[browser-mcp] Fatal error:", error);
  process.exit(1);
});
