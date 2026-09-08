import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, type ElicitRequest, type ElicitResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

export type ElicitHandler = (req: ElicitRequest["params"]) => Promise<ElicitResult>;

/**
 * One MCP client connection to the HomeKeeper server. The simulator keeps a
 * single long-lived connection (one household), mirroring how an Alexa+
 * account-linked add-on would hold a session per customer.
 */
export class HomeKeeperClient {
  private client: Client;
  private transport?: StreamableHTTPClientTransport;
  private tools: Tool[] = [];
  private elicitHandler?: ElicitHandler;
  /** AgentCore routes requests with the same runtime session id to the same microVM. */
  private readonly runtimeSessionId = `${randomUUID()}-homekeeper-sim`;

  constructor() {
    this.client = new Client({ name: "alexa-plus-simulator", version: "0.1.0" }, { capabilities: { elicitation: {} } });
    this.client.setRequestHandler(ElicitRequestSchema, async (req) => {
      if (!this.elicitHandler) return { action: "cancel" } satisfies ElicitResult;
      return this.elicitHandler(req.params);
    });
  }

  setElicitHandler(handler: ElicitHandler | undefined) {
    this.elicitHandler = handler;
  }

  async connect(): Promise<void> {
    const headers: Record<string, string> = {
      "x-household-id": config.householdId,
      "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": this.runtimeSessionId
    };
    if (config.mcpAuth === "bearer" && config.bearerToken) headers.Authorization = `Bearer ${config.bearerToken}`;

    this.transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
      requestInit: { headers },
      fetch: config.mcpAuth === "sigv4" ? sigv4Fetch : undefined
    });
    await this.client.connect(this.transport);
    const { tools } = await this.client.listTools();
    this.tools = tools;
    console.log(`[mcp] connected to ${config.mcpUrl} (${config.mcpAuth}); ${tools.length} tools`);
  }

  async reconnect(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      /* ignore */
    }
    await this.connect();
  }

  listTools(): Tool[] {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>) {
    return this.client.callTool({ name, arguments: args });
  }

  async readResource(uri: string) {
    return this.client.readResource({ uri });
  }
}

// --------------------------------------------------------------------- SigV4

const signer = new SignatureV4({
  service: "bedrock-agentcore",
  region: config.region,
  credentials: fromNodeProviderChain(),
  sha256: Sha256
});

/** A fetch() that SigV4-signs each request for Bedrock AgentCore Runtime (IAM inbound auth). */
async function sigv4Fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const incoming = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const headers: Record<string, string> = { host: url.hostname };
  incoming.forEach((v, k) => {
    headers[k] = v;
  });
  const body = typeof init?.body === "string" ? init.body : undefined;
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    query[k] = v;
  });

  const request = new HttpRequest({
    method: init?.method ?? "GET",
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    query,
    headers,
    body
  });
  const signed = await signer.sign(request);
  return fetch(url, { ...init, body, headers: signed.headers as Record<string, string> });
}
