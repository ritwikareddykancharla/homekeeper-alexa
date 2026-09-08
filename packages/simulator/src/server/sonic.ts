/**
 * Voice turns with Amazon Nova 2 Sonic: one bidirectional stream carries the
 * user's microphone audio in and the assistant's speech out, with speech
 * recognition, reasoning, tool use and synthesis all inside the model. This is
 * the closest thing on Bedrock to how Alexa+ itself talks to an MCP server:
 * Sonic decides to call a HomeKeeper tool, we run it against the MCP server,
 * hand the result back, and Sonic speaks the answer while the card renders.
 *
 * Sonic's own voices are its weak point, so by default its audio is discarded
 * and each sentence it decides to say is spoken by Polly (generative Joanna,
 * the classic Alexa voice) as soon as the text arrives.
 *
 *   SONIC_MODEL_ID  default amazon.nova-2-sonic-v1:0
 *   SONIC_VOICE     tiffany (default) | matthew | amy | olivia | ...   (only heard with SONIC_SPEAKER=sonic)
 *   SONIC_SPEAKER   polly (default) | sonic
 */
import { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand, type InvokeModelWithBidirectionalStreamInput } from "@aws-sdk/client-bedrock-runtime";
import { NodeHttp2Handler } from "@smithy/node-http-handler";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { elicitVia } from "./elicit.js";
import { SYSTEM_PROMPT, toModelContent, uiResourceFor, type HostEvent } from "./host.js";
import type { HomeKeeperClient } from "./mcp-client.js";
import { PCM_RATE, synthesize, ttsInfo } from "./tts.js";

const speaker = (process.env.SONIC_SPEAKER as "polly" | "sonic" | undefined) ?? "polly";

export const sonicInfo = {
  model: process.env.SONIC_MODEL_ID ?? "amazon.nova-2-sonic-v1:0",
  voice: process.env.SONIC_VOICE ?? "tiffany",
  /** Who the user actually hears. */
  speaker: speaker === "polly" ? `Polly ${ttsInfo.voice}` : `Sonic ${process.env.SONIC_VOICE ?? "tiffany"}`,
  inputRate: 16000,
  outputRate: 24000
};

/** Events sent to the browser over the voice WebSocket (superset of HostEvent). */
export type VoiceEvent =
  | HostEvent
  | { type: "ready" }
  | { type: "transcript"; text: string }
  | { type: "audio"; data: string; rate?: number }
  | { type: "interrupted" }
  | { type: "turn_end" }
  | { type: "closed"; reason?: string };

const VOICE_RULES = `

Voice channel notes:
- You are speaking through a real voice model; the user hears you. Keep replies to at most two short sentences.
- Never read step-by-step instructions, lists or excerpts aloud. Give the one-line diagnosis and the single most likely fix, then say the full steps are on screen.
- After calling a tool, speak the result right away.
- If the user's appliance is obvious from context (e.g. "the dishwasher" and there is one dishwasher), call the tool directly instead of listing appliances first.`;

/** Minimal push queue that the SDK consumes as the request body. */
class InputQueue implements AsyncIterable<InvokeModelWithBidirectionalStreamInput> {
  private items: InvokeModelWithBidirectionalStreamInput[] = [];
  private waiters: Array<() => void> = [];
  private ended = false;

  push(event: Record<string, unknown>) {
    if (this.ended) return;
    this.items.push({ chunk: { bytes: Buffer.from(JSON.stringify({ event })) } });
    this.waiters.shift()?.();
  }
  end() {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}

export class SonicSession {
  private client = new BedrockRuntimeClient({
    region: config.region,
    requestHandler: new NodeHttp2Handler({ requestTimeout: 600_000, sessionTimeout: 600_000 })
  });
  private input = new InputQueue();
  private promptName = randomUUID();
  private audioContent = randomUUID();
  private roles = new Map<string, { role: string; stage?: string; type: string }>();
  private closed = false;
  /** Polly speech is chained so sentences play in order; bumping `turn` drops speech from an interrupted turn. */
  private speech: Promise<void> = Promise.resolve();
  private turn = 0;

  constructor(
    private mcp: HomeKeeperClient,
    private send: (ev: VoiceEvent) => void
  ) {}

  async start() {
    const tools = this.mcp.listTools().map((t) => ({
      toolSpec: {
        name: t.name,
        description: t.description ?? t.name,
        inputSchema: { json: JSON.stringify(t.inputSchema ?? { type: "object", properties: {} }) }
      }
    }));

    // Queue the session setup before opening the stream: Bedrock only answers
    // with response headers once it has read the first events, so awaiting
    // send() with an empty body would deadlock.
    this.input.push({
      sessionStart: {
        inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.5 },
        turnDetectionConfiguration: { endpointingSensitivity: "MEDIUM" }
      }
    });
    this.input.push({
      promptStart: {
        promptName: this.promptName,
        textOutputConfiguration: { mediaType: "text/plain" },
        audioOutputConfiguration: {
          mediaType: "audio/lpcm",
          sampleRateHertz: sonicInfo.outputRate,
          sampleSizeBits: 16,
          channelCount: 1,
          voiceId: sonicInfo.voice,
          encoding: "base64",
          audioType: "SPEECH"
        },
        toolUseOutputConfiguration: { mediaType: "application/json" },
        toolConfiguration: { tools }
      }
    });
    this.sendText("SYSTEM", SYSTEM_PROMPT + VOICE_RULES, false);
    this.input.push({
      contentStart: {
        promptName: this.promptName,
        contentName: this.audioContent,
        type: "AUDIO",
        interactive: true,
        role: "USER",
        audioInputConfiguration: {
          mediaType: "audio/lpcm",
          sampleRateHertz: sonicInfo.inputRate,
          sampleSizeBits: 16,
          channelCount: 1,
          audioType: "SPEECH",
          encoding: "base64"
        }
      }
    });

    const response = await this.client.send(
      new InvokeModelWithBidirectionalStreamCommand({ modelId: sonicInfo.model, body: this.input })
    );
    this.send({ type: "ready" });

    void this.pump(response.body!).catch((err) => {
      if (this.closed) return;
      console.error(`[sonic] stream error: ${(err as Error).message}`);
      this.send({ type: "error", message: `Nova 2 Sonic: ${(err as Error).message}` });
      this.close("stream error");
    });
  }

  /** 16 kHz mono PCM16 from the browser microphone. */
  sendAudio(pcm: Buffer) {
    if (this.closed) return;
    this.input.push({ audioInput: { promptName: this.promptName, contentName: this.audioContent, content: pcm.toString("base64") } });
  }

  /** Typed text during a voice session (cross-modal input); Sonic answers aloud. */
  sendUserText(text: string) {
    this.sendText("USER", text, true);
  }

  private sendText(role: "SYSTEM" | "USER", content: string, interactive: boolean) {
    const contentName = randomUUID();
    this.input.push({
      contentStart: { promptName: this.promptName, contentName, type: "TEXT", interactive, role, textInputConfiguration: { mediaType: "text/plain" } }
    });
    this.input.push({ textInput: { promptName: this.promptName, contentName, content } });
    this.input.push({ contentEnd: { promptName: this.promptName, contentName } });
  }

  private sendToolResult(toolUseId: string, result: CallToolResult) {
    const contentName = randomUUID();
    const blocks = toModelContent(result);
    const payload = blocks.length === 1 && "json" in blocks[0] ? blocks[0].json : { content: blocks.map((b) => ("text" in b ? b.text : b.json)) };
    this.input.push({
      contentStart: {
        promptName: this.promptName,
        contentName,
        interactive: false,
        type: "TOOL",
        role: "TOOL",
        toolResultInputConfiguration: { toolUseId, type: "TEXT", textInputConfiguration: { mediaType: "text/plain" } }
      }
    });
    this.input.push({ toolResult: { promptName: this.promptName, contentName, content: JSON.stringify(payload) } });
    this.input.push({ contentEnd: { promptName: this.promptName, contentName } });
  }

  private async pump(body: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }>) {
    for await (const item of body) {
      if (!item.chunk?.bytes) continue;
      const { event } = JSON.parse(Buffer.from(item.chunk.bytes).toString("utf8")) as { event: Record<string, any> };
      if (!event) continue;

      if (event.contentStart) {
        const cs = event.contentStart;
        let stage: string | undefined;
        try {
          stage = cs.additionalModelFields ? (JSON.parse(cs.additionalModelFields) as { generationStage?: string }).generationStage : undefined;
        } catch {
          /* ignore */
        }
        this.roles.set(cs.contentId, { role: cs.role, stage, type: cs.type });
      } else if (event.textOutput) {
        const meta = this.roles.get(event.textOutput.contentId);
        const text = String(event.textOutput.content ?? "").trim();
        if (!text) continue;
        if (meta?.role === "USER") this.send({ type: "transcript", text });
        // SPECULATIVE is what the model is about to say; FINAL repeats what was actually spoken.
        else if (meta?.role === "ASSISTANT" && meta.stage !== "FINAL") {
          this.send({ type: "text", text });
          if (speaker === "polly") this.speak(text);
        }
      } else if (event.audioOutput) {
        if (speaker === "sonic") this.send({ type: "audio", data: event.audioOutput.content });
      } else if (event.toolUse) {
        void this.handleToolUse(event.toolUse);
      } else if (event.contentEnd) {
        const ce = event.contentEnd;
        if (ce.stopReason === "INTERRUPTED") {
          this.turn++;
          this.send({ type: "interrupted" });
        }
        const meta = this.roles.get(ce.contentId);
        if (meta?.type === "AUDIO" && ce.stopReason === "END_TURN") this.send({ type: "turn_end" });
        this.roles.delete(ce.contentId);
      } else if (event.completionEnd) {
        this.send({ type: "turn_end" });
      }
    }
    this.close("stream ended");
  }

  /** Speak one sentence with Polly, in order, unless the turn was interrupted meanwhile. */
  private speak(text: string) {
    const turn = this.turn;
    this.speech = this.speech
      .then(async () => {
        if (turn !== this.turn || this.closed) return;
        const pcm = await synthesize(text, "pcm");
        if (turn !== this.turn || this.closed) return;
        this.send({ type: "audio", data: Buffer.from(pcm).toString("base64"), rate: PCM_RATE });
      })
      .catch((err) => console.warn(`[sonic] Polly failed, sentence dropped: ${(err as Error).message}`));
  }

  private async handleToolUse(tu: { toolName: string; toolUseId: string; content?: string }) {
    let args: Record<string, unknown> = {};
    try {
      args = tu.content ? (JSON.parse(tu.content) as Record<string, unknown>) : {};
    } catch {
      /* leave empty */
    }
    this.send({ type: "tool_call", id: tu.toolUseId, name: tu.toolName, args });
    let result: CallToolResult;
    this.mcp.setElicitHandler(elicitVia(this.send));
    try {
      result = (await this.mcp.callTool(tu.toolName, args)) as CallToolResult;
    } catch (err) {
      result = { content: [{ type: "text", text: `Tool failed: ${(err as Error).message}` }], isError: true };
    } finally {
      this.mcp.setElicitHandler(undefined);
    }
    this.send({ type: "tool_result", id: tu.toolUseId, name: tu.toolName, result, uiResource: uiResourceFor(this.mcp.listTools(), tu.toolName, result) });
    this.sendToolResult(tu.toolUseId, result);
  }

  close(reason?: string) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.input.push({ contentEnd: { promptName: this.promptName, contentName: this.audioContent } });
      this.input.push({ promptEnd: { promptName: this.promptName } });
      this.input.push({ sessionEnd: {} });
    } finally {
      this.input.end();
    }
    this.send({ type: "closed", reason });
  }
}
