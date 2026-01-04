#!/usr/bin/env node
/**
 * Native Messaging Host for OpenCode Browser Automation
 * 
 * This script is launched by Chrome when the extension connects.
 * It communicates with Chrome via stdin/stdout using Chrome's native messaging protocol.
 * It also connects to an MCP server (or acts as one) to receive tool requests.
 * 
 * Chrome Native Messaging Protocol:
 * - Messages are length-prefixed (4 bytes, little-endian, uint32)
 * - Message body is JSON
 */

import { createServer } from "net";
import { writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const LOG_DIR = join(homedir(), ".opencode-browser", "logs");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, "host.log");

function log(...args) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ${args.join(" ")}\n`;
  appendFileSync(LOG_FILE, message);
}

log("Native host started");

// ============================================================================
// Chrome Native Messaging Protocol
// ============================================================================

function readMessage() {
  return new Promise((resolve, reject) => {
    let lengthBuffer = Buffer.alloc(0);
    let messageBuffer = Buffer.alloc(0);
    let messageLength = null;
    
    const processData = () => {
      // First, read the 4-byte length prefix
      if (messageLength === null) {
        const needed = 4 - lengthBuffer.length;
        const chunk = process.stdin.read(needed);
        if (chunk === null) {
          process.stdin.once("readable", processData);
          return;
        }
        
        const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        lengthBuffer = Buffer.concat([lengthBuffer, chunkBuf]);
        
        if (lengthBuffer.length < 4) {
          process.stdin.once("readable", processData);
          return;
        }
        
        messageLength = lengthBuffer.readUInt32LE(0);
        if (messageLength === 0) {
          resolve(null);
          return;
        }
      }
      
      // Now read the message body
      const needed = messageLength - messageBuffer.length;
      const chunk = process.stdin.read(needed);
      if (chunk === null) {
        process.stdin.once("readable", processData);
        return;
      }
      
      const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      messageBuffer = Buffer.concat([messageBuffer, chunkBuf]);
      
      if (messageBuffer.length < messageLength) {
        process.stdin.once("readable", processData);
        return;
      }
      
      try {
        const message = JSON.parse(messageBuffer.toString("utf8"));
        resolve(message);
      } catch (e) {
        reject(new Error(`Failed to parse message: ${e.message}`));
      }
    };
    
    processData();
  });
}

function writeMessage(message) {
  const json = JSON.stringify(message);
  const buffer = Buffer.from(json, "utf8");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32LE(buffer.length, 0);
  
  process.stdout.write(lengthBuffer);
  process.stdout.write(buffer);
}

// ============================================================================
// MCP Server Connection
// ============================================================================

const SOCKET_PATH = join(homedir(), ".opencode-browser", "browser.sock");
let mcpConnected = false;
let mcpSocket = null;
let pendingRequests = new Map();
let requestId = 0;

function connectToMcpServer() {
  // We'll create a Unix socket server that the MCP server connects to
  // This way the host can receive tool requests from OpenCode
  
  // Clean up old socket
  try {
    if (existsSync(SOCKET_PATH)) {
      unlinkSync(SOCKET_PATH);
    }
  } catch {}
  
  const server = createServer((socket) => {
    log("MCP server connected");
    mcpSocket = socket;
    mcpConnected = true;
    
    // Notify extension
    writeMessage({ type: "mcp_connected" });
    
    let buffer = "";
    
    socket.on("data", (data) => {
      buffer += data.toString();
      
      // Process complete JSON messages (newline-delimited)
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            handleMcpMessage(message);
          } catch (e) {
            log("Failed to parse MCP message:", e.message);
          }
        }
      }
    });
    
    socket.on("close", () => {
      log("MCP server disconnected");
      mcpSocket = null;
      mcpConnected = false;
      writeMessage({ type: "mcp_disconnected" });
    });
    
    socket.on("error", (err) => {
      log("MCP socket error:", err.message);
    });
  });
  
  server.listen(SOCKET_PATH, () => {
    log("Listening for MCP connections on", SOCKET_PATH);
  });
  
  server.on("error", (err) => {
    log("Server error:", err.message);
  });
}

function handleMcpMessage(message) {
  log("Received from MCP:", JSON.stringify(message));
  
  if (message.type === "tool_request") {
    // Forward tool request to Chrome extension
    const id = ++requestId;
    pendingRequests.set(id, message.id); // Map our ID to MCP's ID
    
    writeMessage({
      type: "tool_request",
      id,
      tool: message.tool,
      args: message.args
    });
  }
}

function sendToMcp(message) {
  if (mcpSocket && !mcpSocket.destroyed) {
    mcpSocket.write(JSON.stringify(message) + "\n");
  }
}

// ============================================================================
// Handle Messages from Chrome Extension
// ============================================================================

async function handleChromeMessage(message) {
  log("Received from Chrome:", JSON.stringify(message));
  
  switch (message.type) {
    case "ping":
      writeMessage({ type: "pong" });
      break;
      
    case "tool_response":
      // Forward response back to MCP server
      const mcpId = pendingRequests.get(message.id);
      if (mcpId !== undefined) {
        pendingRequests.delete(message.id);
        sendToMcp({
          type: "tool_response",
          id: mcpId,
          result: message.result,
          error: message.error
        });
      }
      break;
      
    case "get_status":
      writeMessage({
        type: "status_response",
        mcpConnected
      });
      break;
  }
}

// ============================================================================
// Main Loop
// ============================================================================

async function main() {
  // Set stdin to flowing mode
  process.stdin.setEncoding(null);
  
  // Start MCP socket server
  connectToMcpServer();
  
  // Read messages from Chrome extension
  while (true) {
    try {
      const message = await readMessage();
      if (message === null) {
        log("Received null message, exiting");
        break;
      }
      await handleChromeMessage(message);
    } catch (error) {
      log("Error reading message:", error.message);
      break;
    }
  }
  
  log("Native host exiting");
  process.exit(0);
}

// Handle graceful shutdown
process.on("SIGTERM", () => {
  log("Received SIGTERM");
  process.exit(0);
});

process.on("SIGINT", () => {
  log("Received SIGINT");
  process.exit(0);
});

main().catch((error) => {
  log("Fatal error:", error.message);
  process.exit(1);
});
