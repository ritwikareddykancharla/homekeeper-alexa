import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { HomeKeeperClient } from "./mcp-client.js";
import { AlexaHost, type HostEvent } from "./host.js";
import { synthesize, ttsInfo } from "./tts.js";

const WEB_DIST = fileURLToPath(new URL("../../dist/web", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const mcp = new HomeKeeperClient();
const host = new AlexaHost(mcp);

/** Elicitation requests waiting on a browser answer. */
const pendingElicits = new Map<string, (r: ElicitResult) => void>();

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  // ---- status
  if (url.pathname === "/api/status" && req.method === "GET") {
    return json(res, 200, {
      mcpUrl: config.mcpUrl,
      auth: config.mcpAuth,
      model: config.modelId,
      mode: host.mode,
      tts: ttsInfo,
      region: config.region,
      household: config.householdId,
      tools: mcp.listTools().map((t) => t.name),
      toolUi: Object.fromEntries(
        mcp
          .listTools()
          .map((t) => [t.name, (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri])
          .filter(([, uri]) => uri)
      )
    });
  }

  // ---- one user turn, streamed as SSE
  if (url.pathname === "/api/chat" && req.method === "POST") {
    const body = await readJson(req);
    const sessionId = String(body.sessionId ?? "default");
    const text = String(body.text ?? "").trim();
    if (!text) return json(res, 400, { error: "text required" });

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (ev: HostEvent) => res.write(`data: ${JSON.stringify(ev)}\n\n`);

    // Route elicitation (server asks user to confirm) through this response stream.
    mcp.setElicitHandler((params) => {
      const id = randomUUID();
      send({ type: "elicit", id, message: params.message, schema: (params as { requestedSchema?: unknown }).requestedSchema });
      return new Promise<ElicitResult>((resolve) => {
        pendingElicits.set(id, resolve);
        setTimeout(() => {
          if (pendingElicits.delete(id)) resolve({ action: "cancel" });
        }, 120_000);
      });
    });

    try {
      for await (const ev of host.turn(sessionId, text)) send(ev);
    } catch (err) {
      send({ type: "error", message: (err as Error).message });
      send({ type: "done" });
    } finally {
      mcp.setElicitHandler(undefined);
      res.end();
    }
    return;
  }

  // ---- browser answers an elicitation
  if (url.pathname === "/api/elicit" && req.method === "POST") {
    const body = await readJson(req);
    const resolve = pendingElicits.get(String(body.id));
    if (!resolve) return json(res, 404, { error: "no pending elicitation" });
    pendingElicits.delete(String(body.id));
    resolve({ action: body.action as ElicitResult["action"], content: body.content as ElicitResult["content"] });
    return json(res, 200, { ok: true });
  }

  // ---- MCP App view calls a server tool (host proxies on its behalf)
  if (url.pathname === "/api/tool" && req.method === "POST") {
    const body = await readJson(req);
    try {
      const result = await mcp.callTool(String(body.name), (body.arguments as Record<string, unknown>) ?? {});
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  }

  // ---- fetch an MCP App view's HTML
  if (url.pathname === "/api/resource" && req.method === "GET") {
    const uri = url.searchParams.get("uri");
    if (!uri) return json(res, 400, { error: "uri required" });
    try {
      const r = await mcp.readResource(uri);
      const first = r.contents[0] as { text?: string; mimeType?: string } | undefined;
      res.writeHead(200, { "content-type": first?.mimeType ?? "text/html" });
      res.end(first?.text ?? "");
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // ---- speech: Amazon Polly generative voice
  if (url.pathname === "/api/tts" && req.method === "POST") {
    const body = await readJson(req);
    const text = String(body.text ?? "").slice(0, 1500);
    if (!text) return json(res, 400, { error: "text required" });
    try {
      const audio = await synthesize(text);
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": audio.byteLength, "cache-control": "no-store" });
      res.end(Buffer.from(audio));
    } catch (err) {
      console.warn(`[tts] Polly failed: ${(err as Error).message}`);
      return json(res, 502, { error: (err as Error).message });
    }
    return;
  }

  if (url.pathname === "/api/reset" && req.method === "POST") {
    const body = await readJson(req);
    host.reset(String(body.sessionId ?? "default"));
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/reconnect" && req.method === "POST") {
    await mcp.reconnect();
    return json(res, 200, { tools: mcp.listTools().length });
  }

  json(res, 404, { error: "not found" });
}

function serveStatic(res: ServerResponse, pathname: string) {
  if (!existsSync(WEB_DIST)) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<h1>HomeKeeper simulator API</h1><p>Web UI not built. Run <code>npm run dev -w @homekeeper/simulator</code> (Vite on :5173) or <code>npm run build</code>.</p>`);
    return;
  }
  let file = normalize(join(WEB_DIST, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(WEB_DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIST, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    else res.end();
  }
});

await mcp.connect().catch((err) => {
  console.error(`[mcp] could not connect to ${config.mcpUrl}: ${(err as Error).message}`);
  console.error("[mcp] start the HomeKeeper server (npm run dev -w @homekeeper/server) or set MCP_URL; will retry on first request");
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`Alexa+ simulator API on http://localhost:${config.port}  (model ${config.modelId}, region ${config.region})`);
});
