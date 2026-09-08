import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool as BedrockTool,
  type ToolResultContentBlock
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type { HomeKeeperClient } from "./mcp-client.js";
import { CANT_HELP, phrase, route } from "./fallback.js";

/** Events streamed to the browser for one user turn. */
export type HostEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: CallToolResult; uiResource?: string }
  | { type: "elicit"; id: string; message: string; schema: unknown }
  | { type: "error"; message: string }
  | { type: "done" };

export const SYSTEM_PROMPT = `You are Alexa+, a warm and efficient voice assistant in someone's home. The HomeKeeper add-on is connected: it remembers the household's appliances, reads their manuals, tracks maintenance and reorders parts.

Rules for speaking:
- You are being spoken aloud. Keep replies to one to three short sentences. No lists, no markdown, no emoji.
- Sound like a warm, unhurried person, not a manual. React first, then inform: "Oh, that one's easy." / "Good news: still covered." Use contractions. Vary sentence length; a two-word sentence is fine. Punctuate for rhythm (commas, a dash, a question) because the punctuation drives the intonation of the voice.
- Match the moment: a little relief when something is fine, a little sympathy when something is broken, never chirpy about a problem.
- When a tool returns a visual card (most do), do not read every detail; summarize and refer to the card ("I've put the steps on screen").
- If a tool returns "candidates" because an appliance reference was ambiguous, ask the user which one they mean. Do not guess.
- Use tools for anything about the household's appliances; never invent appliance facts. If the tool says a manual isn't available, say so plainly.
- For reorders, the tool handles confirmation. If it returns a quote awaiting confirmation, ask the user to confirm; only call it again with confirm=true after they clearly say yes.
- When the user says they did a maintenance task ("I cleaned the filter"), log it with log_maintenance.
- Be concrete about timing ("in three days", "twelve days overdue"), not vague.`;

export class AlexaHost {
  private bedrock = new BedrockRuntimeClient({ region: config.region });
  private conversations = new Map<string, Message[]>();
  /** Per session: last reorder args, so "yes" can confirm it in rules mode. */
  private lastReorder = new Map<string, Record<string, unknown>>();
  private lastTool = new Map<string, string>();
  /** Set once Bedrock fails with an auth/access error; avoids paying the timeout every turn. */
  private bedrockDown = config.hostMode === "rules";

  constructor(private mcp: HomeKeeperClient) {}

  reset(sessionId: string) {
    this.conversations.delete(sessionId);
    this.lastReorder.delete(sessionId);
    this.lastTool.delete(sessionId);
  }

  get mode(): "bedrock" | "rules" {
    return this.bedrockDown ? "rules" : "bedrock";
  }

  async *turn(sessionId: string, userText: string): AsyncGenerator<HostEvent> {
    if (this.bedrockDown) {
      yield* this.rulesTurn(sessionId, userText);
      return;
    }
    yield* this.modelTurn(sessionId, userText);
  }

  /** No-model path: regex intent routing straight to tools; spoken text comes from the tool. */
  private async *rulesTurn(sessionId: string, userText: string): AsyncGenerator<HostEvent> {
    const routed = route(userText, this.lastTool.get(sessionId));
    if (!routed) {
      yield { type: "text", text: CANT_HELP };
      yield { type: "done" };
      return;
    }
    let args = routed.args;
    if (args.__confirmLast) {
      const last = this.lastReorder.get(sessionId);
      if (!last) {
        yield { type: "text", text: "There's nothing waiting for a confirmation." };
        yield { type: "done" };
        return;
      }
      args = { ...last, confirm: true };
    }
    const id = randomUUID();
    yield { type: "tool_call", id, name: routed.tool, args };
    let result: CallToolResult;
    try {
      result = (await this.mcp.callTool(routed.tool, args)) as CallToolResult;
    } catch (err) {
      result = { content: [{ type: "text", text: `Tool failed: ${(err as Error).message}` }], isError: true };
    }
    yield { type: "tool_result", id, name: routed.tool, result, uiResource: uiResourceFor(this.mcp.listTools(), routed.tool, result) };
    yield { type: "text", text: phrase(result) };
    this.lastTool.set(sessionId, routed.tool);
    if (routed.tool === "reorder_consumable" && (result.structuredContent as { status?: string } | undefined)?.status === "quoted") {
      this.lastReorder.set(sessionId, args);
    } else if (routed.tool === "reorder_consumable") {
      this.lastReorder.delete(sessionId);
    }
    yield { type: "done" };
  }

  /** Run one user turn through the Bedrock model/tool loop, emitting events as they happen. */
  private async *modelTurn(sessionId: string, userText: string): AsyncGenerator<HostEvent> {
    const messages = this.conversations.get(sessionId) ?? [];
    messages.push({ role: "user", content: [{ text: userText }] });
    this.conversations.set(sessionId, messages);

    const tools = this.mcp.listTools().map(toBedrockTool);

    for (let hop = 0; hop < 8; hop++) {
      let output: Message | undefined;
      let stopReason: string | undefined;
      try {
        const res = await this.bedrock.send(
          new ConverseCommand({
            modelId: config.modelId,
            system: [{ text: SYSTEM_PROMPT }],
            messages,
            toolConfig: tools.length ? { tools } : undefined,
            inferenceConfig: { maxTokens: 600, temperature: 0.3 }
          })
        );
        output = res.output?.message;
        stopReason = res.stopReason;
      } catch (err) {
        const e = err as Error & { name?: string };
        // Don't poison the history with a turn the model never answered.
        while (messages.length && messages[messages.length - 1].role !== "user") messages.pop();
        messages.pop();
        if (hop === 0 && /AccessDenied|UnrecognizedClient|CredentialsProviderError|ExpiredToken|ResourceNotFound|ValidationException/.test(`${e.name} ${e.message}`)) {
          console.warn(`[host] Bedrock unavailable (${e.name}); switching to rules mode. ${e.message}`);
          this.bedrockDown = true;
          yield* this.rulesTurn(sessionId, userText);
          return;
        }
        yield { type: "error", message: `Bedrock: ${e.message}` };
        yield { type: "done" };
        return;
      }
      if (!output) break;
      messages.push(output);

      const text = (output.content ?? [])
        .filter((b): b is ContentBlock.TextMember => "text" in b && !!b.text)
        .map((b) => b.text.trim())
        .filter(Boolean)
        .join(" ");
      if (text) yield { type: "text", text };

      if (stopReason !== "tool_use") break;

      const toolUses = (output.content ?? []).filter((b): b is ContentBlock.ToolUseMember => "toolUse" in b);
      const results: ContentBlock[] = [];
      for (const { toolUse } of toolUses) {
        const name = toolUse.name!;
        const args = (toolUse.input ?? {}) as Record<string, unknown>;
        const id = toolUse.toolUseId!;
        yield { type: "tool_call", id, name, args };

        let result: CallToolResult;
        try {
          result = (await this.mcp.callTool(name, args)) as CallToolResult;
        } catch (err) {
          result = { content: [{ type: "text", text: `Tool failed: ${(err as Error).message}` }], isError: true };
        }
        yield { type: "tool_result", id, name, result, uiResource: uiResourceFor(this.mcp.listTools(), name, result) };
        results.push({
          toolResult: { toolUseId: id, content: toModelContent(result), status: result.isError ? "error" : "success" }
        });
      }
      messages.push({ role: "user", content: results });
    }
    yield { type: "done" };
  }
}

function toBedrockTool(t: Tool): BedrockTool {
  return {
    toolSpec: {
      name: t.name,
      description: t.description ?? t.name,
      inputSchema: { json: (t.inputSchema ?? { type: "object", properties: {} }) as DocumentType }
    }
  };
}

/** What the model sees: structured JSON when present, otherwise the text blocks. */
export function toModelContent(result: CallToolResult): ToolResultContentBlock[] {
  if (result.structuredContent) {
    // Strip large embedded fields the card renders but the model doesn't need verbatim.
    const trimmed = JSON.parse(JSON.stringify(result.structuredContent, (k, v) => (k === "excerpt" && typeof v === "string" ? v.slice(0, 400) : v)));
    return [{ json: trimmed as DocumentType }];
  }
  const texts = result.content.filter((c) => c.type === "text").map((c) => ({ text: (c as { text: string }).text }));
  return texts.length ? texts : [{ text: "(no content)" }];
}

/**
 * MCP Apps: the UI resource is declared on the tool definition
 * (`tools/list` → `_meta.ui.resourceUri`). A result may also carry one.
 */
export function uiResourceFor(tools: Tool[], name: string, result: CallToolResult): string | undefined {
  const fromResult = (result._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
  if (fromResult) return fromResult;
  const tool = tools.find((t) => t.name === name);
  return (tool?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
}
