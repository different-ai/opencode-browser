/**
 * Minimal Chrome DevTools Protocol client backed by a raw WebSocket.
 */

import WebSocket from "ws";

type CDPResponse = {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

export type BrowserTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
};

export type CDPRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export const DEFAULT_CDP_DISCOVERY_TIMEOUT_MS = 5_000;
export const DEFAULT_CDP_CONNECTION_TIMEOUT_MS = 5_000;
export const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 30_000;

type PendingRequest = {
  resolve: (value: CDPResponse) => void;
  reject: (error: Error) => void;
};

type Deadline = {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
};

function createDeadline(timeoutMs: number, parentSignal?: AbortSignal): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(`${fallback}: ${String(value)}`);
}

function timeoutError(stage: string, timeoutMs: number, endpoint: string): Error {
  return new Error(`CDP ${stage} timed out after ${timeoutMs}ms: ${endpoint}`);
}

function cancellationError(stage: string): Error {
  return new Error(`CDP ${stage} cancelled`);
}

export class CDPClient {
  private ws: WebSocket | null = null;
  private id = 0;
  private pending = new Map<number, PendingRequest>();
  private eventHandlers = new Map<string, Array<(params: Record<string, unknown>) => void>>();

  constructor(public readonly endpoint: string) {}

  async connect(options: CDPRequestOptions = {}): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const timeoutMs = options.timeoutMs ?? DEFAULT_CDP_CONNECTION_TIMEOUT_MS;
    const deadline = createDeadline(timeoutMs, options.signal);

    return await new Promise((resolve, reject) => {
      let socket: WebSocket | null = null;
      let settled = false;

      const cleanup = () => {
        deadline.signal.removeEventListener("abort", onAbort);
        deadline.cleanup();
      };

      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.ws === socket) this.ws = null;
        socket?.terminate();
        reject(asError(error, "CDP connection failed"));
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const onAbort = () => {
        fail(deadline.didTimeout()
          ? timeoutError("connection", timeoutMs, this.endpoint)
          : cancellationError("connection"));
      };

      deadline.signal.addEventListener("abort", onAbort, { once: true });
      if (deadline.signal.aborted) {
        onAbort();
        return;
      }

      try {
        socket = new WebSocket(this.endpoint);
        this.ws = socket;
        socket.once("open", succeed);
        socket.on("error", (error) => {
          if (!settled) fail(error);
          else this.rejectPending(asError(error, "CDP connection failed"));
        });
        socket.on("message", (data: Buffer) => {
          let msg: CDPResponse & { method?: string; params?: Record<string, unknown> };
          try {
            msg = JSON.parse(data.toString()) as typeof msg;
          } catch (error) {
            this.rejectPending(asError(error, "Invalid CDP message"));
            return;
          }

          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            p.resolve(msg);
          }
          if (msg.method && this.eventHandlers.has(msg.method)) {
            for (const handler of this.eventHandlers.get(msg.method)!) {
              handler(msg.params ?? {});
            }
          }
        });
        socket.on("close", () => {
          if (!settled) {
            fail(new Error("CDP connection closed before opening"));
            return;
          }

          if (this.ws === socket) this.ws = null;
          this.rejectPending(new Error("CDP connection closed"));
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    options: CDPRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP not connected");
    }

    const id = ++this.id;
    const timeoutMs = options.timeoutMs ?? DEFAULT_CDP_COMMAND_TIMEOUT_MS;
    const deadline = createDeadline(timeoutMs, options.signal);

    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        deadline.signal.removeEventListener("abort", onAbort);
        deadline.cleanup();
      };

      const onAbort = () => {
        this.pending.delete(id);
        cleanup();
        reject(deadline.didTimeout()
          ? timeoutError(`command ${method}`, timeoutMs, this.endpoint)
          : cancellationError(`command ${method}`));
      };

      this.pending.set(id, {
        resolve: (msg) => {
          cleanup();
          if (msg.error) reject(new Error(`CDP error: ${msg.error.message}`));
          else resolve(msg.result ?? {});
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });

      deadline.signal.addEventListener("abort", onAbort, { once: true });
      if (deadline.signal.aborted) {
        onAbort();
        return;
      }

      try {
        this.ws!.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(asError(error, `Failed to send CDP command ${method}`));
      }
    });
  }

  on(event: string, handler: (params: Record<string, unknown>) => void): void {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
    this.eventHandlers.get(event)!.push(handler);
  }

  close(error: Error = new Error("CDP connection closed")): void {
    const socket = this.ws;
    this.ws = null;
    this.rejectPending(error);
    if (!socket) return;

    if (socket.readyState === WebSocket.OPEN) socket.close();
    else socket.terminate();
  }
}

export async function listTargets(
  browserUrl: string,
  options: CDPRequestOptions = {},
): Promise<BrowserTarget[]> {
  const url = browserUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_CDP_DISCOVERY_TIMEOUT_MS;
  const deadline = createDeadline(timeoutMs, options.signal);

  try {
    const res = await fetch(`${url}/json/list`, { signal: deadline.signal });
    if (!res.ok) throw new Error(`Failed to list targets: ${res.status}`);
    const targets = (await res.json()) as BrowserTarget[];

    const parsed = new URL(url);
    const isProxy = !["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname);
    if (isProxy) {
      const wsScheme = parsed.protocol === "https:" ? "wss:" : "ws:";
      for (const target of targets) {
        if (target.webSocketDebuggerUrl) {
          const wsPath = new URL(target.webSocketDebuggerUrl).pathname;
          target.webSocketDebuggerUrl = `${wsScheme}//${parsed.host}${wsPath}`;
        }
      }
    }

    return targets;
  } catch (error) {
    if (deadline.didTimeout()) throw timeoutError("target discovery", timeoutMs, url);
    if (options.signal?.aborted) throw cancellationError("target discovery");
    throw error;
  } finally {
    deadline.cleanup();
  }
}

export async function connectTarget(wsUrl: string, options: CDPRequestOptions = {}): Promise<CDPClient> {
  const client = new CDPClient(wsUrl);
  await client.connect(options);
  return client;
}

export async function connectFirstPage(
  browserUrl: string,
  options: CDPRequestOptions = {},
): Promise<{ client: CDPClient; target: { id: string; title: string; url: string } }> {
  const targets = await listTargets(browserUrl, options);
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("No page target found");
  const client = await connectTarget(page.webSocketDebuggerUrl, options);
  return { client, target: { id: page.id, title: page.title, url: page.url } };
}
