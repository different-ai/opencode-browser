#!/usr/bin/env node
"use strict";

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE_DIR = path.join(os.homedir(), ".opencode-browser");
const SOCKET_PATH = path.join(BASE_DIR, "broker.sock");

fs.mkdirSync(BASE_DIR, { recursive: true });

function nowIso() {
  return new Date().toISOString();
}

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

function wantsTab(toolName) {
  return !["get_tabs", "get_active_tab"].includes(toolName);
}

// --- State ---
let host = null; // { socket }
let nextExtId = 0;
const extPending = new Map(); // extId -> { pluginSocket, pluginRequestId, sessionId }

const clients = new Set();

// Tab ownership: tabId -> { sessionId, claimedAt }
const claims = new Map();

function listClaims() {
  const out = [];
  for (const [tabId, info] of claims.entries()) {
    out.push({ tabId, ...info });
  }
  out.sort((a, b) => a.tabId - b.tabId);
  return out;
}

function releaseClaimsForSession(sessionId) {
  for (const [tabId, info] of claims.entries()) {
    if (info.sessionId === sessionId) claims.delete(tabId);
  }
}

function checkClaim(tabId, sessionId) {
  const existing = claims.get(tabId);
  if (!existing) return { ok: true };
  if (existing.sessionId === sessionId) return { ok: true };
  return { ok: false, error: `Tab ${tabId} is owned by another OpenCode session (${existing.sessionId})` };
}

function setClaim(tabId, sessionId) {
  claims.set(tabId, { sessionId, claimedAt: nowIso() });
}

function ensureHost() {
  if (host && host.socket && !host.socket.destroyed) return;
  throw new Error("Chrome extension is not connected (native host offline)");
}

function callExtension(tool, args, sessionId) {
  ensureHost();
  const extId = ++nextExtId;

  return new Promise((resolve, reject) => {
    extPending.set(extId, { resolve, reject, sessionId });
    writeJsonLine(host.socket, {
      type: "to_extension",
      message: { type: "tool_request", id: extId, tool, args },
    });

    const timeout = setTimeout(() => {
      if (!extPending.has(extId)) return;
      extPending.delete(extId);
      reject(new Error("Timed out waiting for extension"));
    }, 60000);

    // attach timeout to resolver
    const pending = extPending.get(extId);
    if (pending) pending.timeout = timeout;
  });
}

async function resolveActiveTab(sessionId) {
  const res = await callExtension("get_active_tab", {}, sessionId);
  const tabId = res && typeof res.tabId === "number" ? res.tabId : undefined;
  if (!tabId) throw new Error("Could not determine active tab");
  return tabId;
}

async function handleTool(pluginSocket, req) {
  const { tool, args = {}, sessionId } = req;
  if (!tool) throw new Error("Missing tool");

  let tabId = args.tabId;

  if (wantsTab(tool)) {
    if (typeof tabId !== "number") {
      tabId = await resolveActiveTab(sessionId);
    }

    const claimCheck = checkClaim(tabId, sessionId);
    if (!claimCheck.ok) throw new Error(claimCheck.error);
  }

  const res = await callExtension(tool, { ...args, tabId }, sessionId);

  const usedTabId =
    res && typeof res.tabId === "number" ? res.tabId : typeof tabId === "number" ? tabId : undefined;
  if (typeof usedTabId === "number") {
    // Auto-claim on first touch
    const existing = claims.get(usedTabId);
    if (!existing) setClaim(usedTabId, sessionId);
  }

  return res;
}

function handleClientMessage(socket, client, msg) {
  if (msg && msg.type === "hello") {
    client.role = msg.role || "unknown";
    client.sessionId = msg.sessionId;
    if (client.role === "native-host") {
      host = { socket };
      // allow host to see current state
      writeJsonLine(socket, { type: "host_ready", claims: listClaims() });
    }
    return;
  }

  if (msg && msg.type === "from_extension") {
    const message = msg.message;
    if (message && message.type === "tool_response" && typeof message.id === "number") {
      const pending = extPending.get(message.id);
      if (!pending) return;
      extPending.delete(message.id);
      if (pending.timeout) clearTimeout(pending.timeout);

      if (message.error) {
        pending.reject(new Error(message.error.content || String(message.error)));
      } else {
        // Forward full result payload so callers can read tabId
        pending.resolve(message.result);
      }
    }
    return;
  }

  if (msg && msg.type === "request" && typeof msg.id === "number") {
    const requestId = msg.id;
    const sessionId = msg.sessionId || client.sessionId;

    const replyOk = (data) => writeJsonLine(socket, { type: "response", id: requestId, ok: true, data });
    const replyErr = (err) =>
      writeJsonLine(socket, { type: "response", id: requestId, ok: false, error: err.message || String(err) });

    (async () => {
      try {
        if (msg.op === "status") {
          replyOk({ broker: true, hostConnected: !!host && !!host.socket && !host.socket.destroyed, claims: listClaims() });
          return;
        }

        if (msg.op === "list_claims") {
          replyOk({ claims: listClaims() });
          return;
        }

        if (msg.op === "claim_tab") {
          const tabId = msg.tabId;
          const force = !!msg.force;
          if (typeof tabId !== "number") throw new Error("tabId is required");
          const existing = claims.get(tabId);
          if (existing && existing.sessionId !== sessionId && !force) {
            throw new Error(`Tab ${tabId} is owned by another OpenCode session (${existing.sessionId})`);
          }
          setClaim(tabId, sessionId);
          replyOk({ ok: true, tabId, sessionId });
          return;
        }

        if (msg.op === "release_tab") {
          const tabId = msg.tabId;
          if (typeof tabId !== "number") throw new Error("tabId is required");
          const existing = claims.get(tabId);
          if (!existing) {
            replyOk({ ok: true, tabId, released: false });
            return;
          }
          if (existing.sessionId !== sessionId) {
            throw new Error(`Tab ${tabId} is owned by another OpenCode session (${existing.sessionId})`);
          }
          claims.delete(tabId);
          replyOk({ ok: true, tabId, released: true });
          return;
        }

        if (msg.op === "tool") {
          const result = await handleTool(socket, { tool: msg.tool, args: msg.args || {}, sessionId });
          replyOk(result);
          return;
        }

        throw new Error(`Unknown op: ${msg.op}`);
      } catch (e) {
        replyErr(e);
      }
    })();

    return;
  }
}

function start() {
  try {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
  } catch {
    // ignore
  }

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);

    const client = { role: "unknown", sessionId: null };
    clients.add(client);

    socket.on(
      "data",
      createJsonLineParser((msg) => handleClientMessage(socket, client, msg))
    );

    socket.on("close", () => {
      clients.delete(client);
      if (client.role === "native-host" && host && host.socket === socket) {
        host = null;
        // fail pending extension requests
        for (const [extId, pending] of extPending.entries()) {
          extPending.delete(extId);
          if (pending.timeout) clearTimeout(pending.timeout);
          pending.reject(new Error("Native host disconnected"));
        }
      }
      if (client.sessionId) releaseClaimsForSession(client.sessionId);
    });

    socket.on("error", () => {
      // close handler will clean up
    });
  });

  server.listen(SOCKET_PATH, () => {
    // Make socket group-readable; ignore errors
    try {
      fs.chmodSync(SOCKET_PATH, 0o600);
    } catch {}
    console.error(`[browser-broker] listening on ${SOCKET_PATH}`);
  });

  server.on("error", (err) => {
    console.error("[browser-broker] server error", err);
    process.exit(1);
  });
}

start();
