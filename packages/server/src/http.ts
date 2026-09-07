import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface HttpOptions {
  /** Build a fresh McpServer for a session (stateful) or request (stateless). */
  createServer: () => McpServer;
  /** Stateless mode: no session ids, one server per request. Required for some load-balanced hosts. */
  stateless?: boolean;
  /** Path for the MCP endpoint. AgentCore expects /mcp. */
  path?: string;
  /** Idle session eviction in ms (stateful mode). */
  sessionTtlMs?: number;
  log?: (msg: string) => void;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-Household-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version"
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

/**
 * Node HTTP server exposing the MCP Streamable HTTP transport (spec 2025-11-25)
 * plus a /ping health endpoint. Supports both stateful sessions (default) and
 * stateless per-request servers.
 */
export function createHttpServer(opts: HttpOptions) {
  const path = opts.path ?? "/mcp";
  const ttl = opts.sessionTtlMs ?? 30 * 60_000;
  const log = opts.log ?? (() => {});
  const sessions = new Map<string, Session>();

  const evict = setInterval(() => {
    const cutoff = Date.now() - ttl;
    for (const [id, s] of sessions) {
      if (s.lastSeen < cutoff) {
        log(`session ${id} expired`);
        void s.transport.close();
        sessions.delete(id);
      }
    }
  }, 60_000);
  evict.unref();

  async function handleStateless(req: IncomingMessage, res: ServerResponse) {
    const server = opts.createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    const body = req.method === "POST" ? await readJson(req) : undefined;
    await transport.handleRequest(req, res, body);
  }

  async function handleStateful(req: IncomingMessage, res: ServerResponse) {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const body = req.method === "POST" ? await readJson(req) : undefined;

    if (sessionId && sessions.has(sessionId)) {
      const s = sessions.get(sessionId)!;
      s.lastSeen = Date.now();
      await s.transport.handleRequest(req, res, body);
      if (req.method === "DELETE") {
        sessions.delete(sessionId);
        log(`session ${sessionId} closed by client`);
      }
      return;
    }

    if (req.method === "POST" && isInitializeRequest(body)) {
      // A new session. Some platforms (Bedrock AgentCore) inject their own
      // Mcp-Session-Id on the initialize request for routing affinity; honour
      // it so the id the client sees is the one we key our session on.
      const server = opts.createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId ?? randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, lastSeen: Date.now() });
          log(`session ${id} initialized`);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        }
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (sessionId) {
      // Unknown or expired session: the client must re-initialize.
      json(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      return;
    }
    json(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: missing session or not an initialize request" }, id: null });
  }

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }
      if (url.pathname === "/ping" || url.pathname === "/health" || url.pathname === "/") {
        json(res, 200, { status: "Healthy", server: "homekeeper", sessions: sessions.size, mode: opts.stateless ? "stateless" : "stateful" });
        return;
      }
      if (url.pathname !== path) {
        json(res, 404, { error: "not found" });
        return;
      }
      for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
      if (opts.stateless) await handleStateless(req, res);
      else await handleStateful(req, res);
    } catch (err) {
      console.error("[http] request failed:", err);
      if (!res.headersSent) json(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      else res.end();
    }
  });

  return {
    server: httpServer,
    sessions,
    listen(port: number, host = "0.0.0.0") {
      return new Promise<void>((resolve) => httpServer.listen(port, host, () => resolve()));
    },
    async close() {
      clearInterval(evict);
      for (const s of sessions.values()) await s.transport.close();
      sessions.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  };
}
