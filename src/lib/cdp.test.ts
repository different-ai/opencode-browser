import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { connectTarget, listTargets } from "./cdp.ts";

async function listen(server: NetServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server: NetServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("listTargets times out when the CDP HTTP endpoint accepts but never responds", async () => {
  const server = createHttpServer(() => {});
  const port = await listen(server);

  try {
    await assert.rejects(
      listTargets("http://127.0.0.1:" + port, { timeoutMs: 50 }),
      /CDP target discovery timed out after 50ms/,
    );
  } finally {
    await close(server);
  }
});

test("listTargets stops when the caller aborts target discovery", async () => {
  const server = createHttpServer(() => {});
  const port = await listen(server);
  const controller = new AbortController();

  try {
    const pending = listTargets("http://127.0.0.1:" + port, {
      signal: controller.signal,
      timeoutMs: 1000,
    });
    controller.abort();
    await assert.rejects(pending, /CDP target discovery cancelled/);
  } finally {
    await close(server);
  }
});

test("connectTarget times out when the WebSocket handshake never completes", async () => {
  const server = createNetServer(() => {});
  const port = await listen(server);

  try {
    await assert.rejects(
      connectTarget("ws://127.0.0.1:" + port, { timeoutMs: 50 }),
      /CDP connection timed out after 50ms/,
    );
  } finally {
    await close(server);
  }
});

test("closing a connected client rejects pending CDP commands", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  server.on("connection", () => {
    // Keep commands pending so the client-side cleanup path is exercised.
  });

  try {
    const client = await connectTarget("ws://127.0.0.1:" + address.port);
    const pending = client.send("Runtime.evaluate", { expression: "1" });
    client.close();
    await assert.rejects(pending, /CDP connection closed/);
  } finally {
    for (const client of server.clients) client.terminate();
    server.close();
  }
});
