#!/usr/bin/env node
"use strict";

// Chrome Native Messaging host for OpenCode Browser.
// Speaks length-prefixed JSON over stdin/stdout and forwards messages to the local broker over a unix socket.

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const BASE_DIR = path.join(os.homedir(), ".opencode-browser");
const SOCKET_PATH = path.join(BASE_DIR, "broker.sock");
const BROKER_PATH = path.join(BASE_DIR, "broker.cjs");

fs.mkdirSync(BASE_DIR, { recursive: true });

function createJsonLineParser(onMessage) {
  let buffer = "";
  return (chunk) => {
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

function writeJsonLine(socket, msg) {
  socket.write(JSON.stringify(msg) + "\n");
}

function maybeStartBroker() {
  try {
    if (!fs.existsSync(BROKER_PATH)) return;
    const child = spawn(process.execPath, [BROKER_PATH], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // ignore
  }
}

async function connectToBroker() {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => reject(err));
  });
}

async function ensureBroker() {
  try {
    return await connectToBroker();
  } catch {
    maybeStartBroker();
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        return await connectToBroker();
      } catch {}
    }
    throw new Error("Could not connect to broker");
  }
}

// --- Native messaging framing ---
let stdinBuffer = Buffer.alloc(0);

function writeNativeMessage(obj) {
  try {
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    process.stdout.write(Buffer.concat([header, payload]));
  } catch (e) {
    console.error("[native-host] write error", e);
  }
}

function onStdinData(chunk, onMessage) {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  while (stdinBuffer.length >= 4) {
    const len = stdinBuffer.readUInt32LE(0);
    if (stdinBuffer.length < 4 + len) return;
    const body = stdinBuffer.slice(4, 4 + len);
    stdinBuffer = stdinBuffer.slice(4 + len);
    try {
      onMessage(JSON.parse(body.toString("utf8")));
    } catch {
      // ignore
    }
  }
}

(async () => {
  const broker = await ensureBroker();
  broker.setNoDelay(true);
  broker.on("data", createJsonLineParser((msg) => {
    if (msg && msg.type === "to_extension" && msg.message) {
      writeNativeMessage(msg.message);
    }
  }));

  broker.on("close", () => {
    process.exit(0);
  });

  broker.on("error", () => {
    process.exit(1);
  });

  writeJsonLine(broker, { type: "hello", role: "native-host" });

  process.stdin.on("data", (chunk) =>
    onStdinData(chunk, (message) => {
      // Forward extension-origin messages to broker.
      writeJsonLine(broker, { type: "from_extension", message });
    })
  );

  process.stdin.on("end", () => {
    try {
      broker.end();
    } catch {}
    process.exit(0);
  });
})();
