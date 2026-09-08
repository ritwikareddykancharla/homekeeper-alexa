/**
 * Browser side of the live voice channel: microphone -> 16 kHz PCM16 over a
 * WebSocket -> Nova 2 Sonic (server) -> 24 kHz PCM16 back -> speakers.
 * Barge-in: when the server says "interrupted", queued audio is dropped.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type VoiceEvent =
  | { type: "ready" }
  | { type: "transcript"; text: string }
  | { type: "text"; text: string }
  | { type: "audio"; data: string; rate?: number }
  | { type: "interrupted" }
  | { type: "turn_end" }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: CallToolResult; uiResource?: string }
  | { type: "elicit"; id: string; message: string; schema: unknown }
  | { type: "error"; message: string }
  | { type: "closed"; reason?: string };

const IN_RATE = 16000;
const OUT_RATE = 24000;
const FRAME = 512; // 32 ms at 16 kHz

const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("hk-capture", Capture);`;

export class VoiceSession {
  private ws?: WebSocket;
  private inCtx?: AudioContext;
  private outCtx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private pending: Float32Array[] = [];
  private pendingLen = 0;
  private playhead = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private speakingTimer?: number;

  constructor(
    private onEvent: (ev: VoiceEvent) => void,
    private onSpeaking: (speaking: boolean) => void
  ) {}

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    this.inCtx = new AudioContext({ sampleRate: IN_RATE });
    this.outCtx = new AudioContext({ sampleRate: OUT_RATE });
    await this.inCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" })));

    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws/voice`);
    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      this.ws!.onerror = () => reject(new Error("voice socket failed"));
    });
    this.ws.onmessage = (m) => this.handle(JSON.parse(m.data as string) as VoiceEvent);
    this.ws.onclose = () => this.stop();
    this.ws.send(JSON.stringify({ type: "start" }));

    const src = this.inCtx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.inCtx, "hk-capture");
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onFrame(e.data);
    src.connect(this.node);
    // Keep the graph alive without echoing the mic to the speakers.
    const sink = this.inCtx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(this.inCtx.destination);
  }

  /** Typed text during a live session goes to Sonic too, so it answers aloud. */
  sendText(text: string) {
    this.ws?.send(JSON.stringify({ type: "text", text }));
  }

  stop() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "stop" }));
    this.ws?.close();
    this.ws = undefined;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.inCtx?.close();
    this.flushPlayback();
    void this.outCtx?.close();
    this.inCtx = this.outCtx = undefined;
    this.onEvent({ type: "closed" });
  }

  // ---- microphone -> server
  private onFrame(f: Float32Array) {
    const rate = this.inCtx?.sampleRate ?? IN_RATE;
    const frame = rate === IN_RATE ? f : downsample(f, rate, IN_RATE);
    this.pending.push(frame);
    this.pendingLen += frame.length;
    if (this.pendingLen < FRAME) return;
    const pcm = new Int16Array(this.pendingLen);
    let o = 0;
    for (const p of this.pending) {
      for (let i = 0; i < p.length; i++) pcm[o++] = Math.max(-32768, Math.min(32767, Math.round(p[i] * 32767)));
    }
    this.pending = [];
    this.pendingLen = 0;
    if (this.open) this.ws!.send(pcm.buffer);
  }

  // ---- server -> speakers
  private handle(ev: VoiceEvent) {
    if (ev.type === "audio") {
      this.enqueue(ev.data, ev.rate ?? OUT_RATE);
      return;
    }
    if (ev.type === "interrupted") this.flushPlayback();
    this.onEvent(ev);
  }

  private enqueue(b64: string, rate: number) {
    const ctx = this.outCtx;
    if (!ctx) return;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    // Buffers carry their own sample rate (Sonic 24 kHz, Polly 16 kHz); the context resamples.
    const buf = ctx.createBuffer(1, pcm.length, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.02, this.playhead);
    src.start(startAt);
    this.playhead = startAt + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    this.onSpeaking(true);
    window.clearTimeout(this.speakingTimer);
    this.speakingTimer = window.setTimeout(() => this.onSpeaking(false), (this.playhead - ctx.currentTime) * 1000 + 50);
  }

  private flushPlayback() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already ended */
      }
    }
    this.sources.clear();
    this.playhead = 0;
    window.clearTimeout(this.speakingTimer);
    this.onSpeaking(false);
  }
}

function downsample(input: Float32Array, from: number, to: number): Float32Array {
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}
