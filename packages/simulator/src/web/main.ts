import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mountApp } from "./apps.js";
import { VoiceSession, type VoiceEvent } from "./voice.js";

type HostEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: CallToolResult; uiResource?: string }
  | { type: "elicit"; id: string; message: string; schema: unknown }
  | { type: "error"; message: string }
  | { type: "done" };

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const transcript = $<HTMLElement>("#transcript");
const stage = $<HTMLElement>(".stage");
const status = $<HTMLElement>("#status");
const orb = $<HTMLElement>("#orb");
const form = $<HTMLFormElement>("#form");
const input = $<HTMLInputElement>("#input");
const mic = $<HTMLButtonElement>("#mic");
const tts = $<HTMLInputElement>("#tts");
const voicePick = $<HTMLSelectElement>("#voicePick");

const sessionId = crypto.randomUUID();
const pendingArgs = new Map<string, Record<string, unknown>>();
const toolUi = new Map<string, string>();
let busy = false;

// ----------------------------------------------------------------- status
async function loadStatus() {
  try {
    const s = (await (await fetch("/api/status")).json()) as {
      tools: string[];
      toolUi: Record<string, string>;
      mcpUrl: string;
      auth: string;
      model: string;
      mode: string;
      tts?: { voice: string; engine: string };
      voice?: { model: string; voice: string; speaker: string };
    };
    for (const [k, v] of Object.entries(s.toolUi ?? {})) toolUi.set(k, v);
    const target = s.mcpUrl.includes("bedrock-agentcore") ? "AgentCore Runtime" : s.mcpUrl;
    const brain = s.mode === "rules" ? "rules mode (no Bedrock)" : s.model.replace(/^[a-z]{2}\./, "").split(".").slice(-1)[0].split("-").slice(0, 3).join(" ");
    const voice = voiceSession ? ` · live: Nova 2 Sonic + ${s.voice?.speaker ?? "Polly"}` : s.tts ? ` · Polly ${s.tts.voice}` : "";
    status.textContent = `${s.tools.length} tools · ${target} · ${s.auth} · ${brain}${voice}`;
    status.classList.toggle("err", s.tools.length === 0);
    if (s.tools.length === 0) status.textContent = "MCP server unreachable (is it running on :3000?)";
  } catch {
    status.textContent = "simulator API unreachable";
    status.classList.add("err");
  }
}

// ---------------------------------------------------------- voice picker
const SAMPLE: Record<string, string> = {
  default: "Hi, I'm {name}. Oh, and good news: your washer's still under warranty."
};

async function loadVoices() {
  try {
    const v = (await (await fetch("/api/voice")).json()) as {
      current: { voice: string; engine: string };
      voices: Array<{ id: string; name: string; gender: string; engine: string }>;
    };
    voicePick.replaceChildren();
    const label: Record<string, string> = { generative: "generative", "long-form": "long-form · most expressive", neural: "neural" };
    for (const engine of ["generative", "long-form", "neural"]) {
      const group = document.createElement("optgroup");
      group.label = label[engine] ?? engine;
      for (const vo of v.voices.filter((x) => x.engine === engine)) {
        const o = document.createElement("option");
        o.value = `${vo.engine}:${vo.id}`;
        o.textContent = `${vo.name} (${vo.gender[0] ?? ""})`;
        group.appendChild(o);
      }
      if (group.children.length) voicePick.appendChild(group);
    }
    voicePick.value = `${v.current.engine}:${v.current.voice}`;
  } catch {
    voicePick.hidden = true;
  }
}

voicePick.addEventListener("change", async () => {
  const [engine, voice] = voicePick.value.split(":");
  const res = await fetch("/api/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ voice, engine }) });
  if (!res.ok) {
    addAlexa(`Couldn't switch voice: ${((await res.json()) as { error: string }).error}`);
    return;
  }
  void loadStatus();
  void speak(SAMPLE.default.replace("{name}", voice));
});

// -------------------------------------------------------------- rendering
function scroll() {
  stage.scrollTo({ top: stage.scrollHeight, behavior: "smooth" });
}

function addUser(text: string) {
  document.querySelector(".hint")?.remove();
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = `<div class="bubble"></div>`;
  el.querySelector(".bubble")!.textContent = text;
  transcript.appendChild(el);
  scroll();
}

function addAlexa(text: string, thinking = false): HTMLElement {
  const el = document.createElement("div");
  el.className = "msg alexa";
  el.innerHTML = `<div class="bubble${thinking ? " thinking" : ""}"></div>`;
  el.querySelector(".bubble")!.textContent = text;
  transcript.appendChild(el);
  scroll();
  return el;
}

function addTool(name: string, args: Record<string, unknown>, err = false) {
  const el = document.createElement("div");
  el.className = `tool${err ? " err" : ""}`;
  const summary = Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  el.innerHTML = `<span>${err ? "✕" : "⚙"}</span><code>${name}</code><span>${summary}</span>`;
  transcript.appendChild(el);
  scroll();
}

async function addApp(name: string, args: Record<string, unknown>, result: CallToolResult, uri: string) {
  const wrap = document.createElement("div");
  wrap.className = "msg alexa app";
  transcript.appendChild(wrap);
  try {
    const html = await (await fetch(`/api/resource?uri=${encodeURIComponent(uri)}`)).text();
    await mountApp(wrap, html, name, args, result, {
      onUserMessage: (text) => void send(text),
      onNestedResult: (n, r) => {
        // Views mostly navigate via say(); only surface a nested card if the tool has its own UI.
        const nestedUri = toolUi.get(n);
        if (nestedUri && n !== name) void addApp(n, {}, r, nestedUri);
      }
    });
  } catch (err) {
    wrap.textContent = `Could not render card: ${(err as Error).message}`;
  }
  scroll();
}

function addElicit(id: string, message: string) {
  const el = document.createElement("div");
  el.className = "msg alexa";
  el.innerHTML = `<div class="elicit"><p></p><div class="actions"><button class="yes">Yes, go ahead</button><button class="no">Not now</button></div></div>`;
  el.querySelector("p")!.textContent = message;
  const answer = async (action: "accept" | "decline", content?: Record<string, unknown>) => {
    el.querySelector(".elicit")!.classList.add("answered");
    await fetch("/api/elicit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, action, content }) });
  };
  el.querySelector(".yes")!.addEventListener("click", () => void answer("accept", { confirm: true }));
  el.querySelector(".no")!.addEventListener("click", () => void answer("decline"));
  transcript.appendChild(el);
  scroll();
  void speak(message);
}

// ------------------------------------------------------------------ voice
let player: HTMLAudioElement | undefined;
let pollyOk = true;

/** Speak with Amazon Polly (generative voice) via the API; fall back to the browser voice. */
async function speak(text: string) {
  if (!tts.checked) return;
  stopSpeaking();
  if (pollyOk) {
    try {
      const res = await fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      if (!res.ok) throw new Error(`tts ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      player = new Audio(url);
      player.onplay = () => orb.classList.add("speaking");
      player.onended = player.onpause = () => {
        orb.classList.remove("speaking");
        URL.revokeObjectURL(url);
      };
      await player.play();
      return;
    } catch (err) {
      console.warn("Polly unavailable, using browser voice:", err);
      pollyOk = false;
    }
  }
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  const voices = speechSynthesis.getVoices();
  u.voice = voices.find((v) => /Samantha|Google US English|Karen|Moira/.test(v.name)) ?? voices.find((v) => v.lang.startsWith("en")) ?? null;
  u.onstart = () => orb.classList.add("speaking");
  u.onend = () => orb.classList.remove("speaking");
  speechSynthesis.speak(u);
}

function stopSpeaking() {
  player?.pause();
  player = undefined;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

// ------------------------------------------------------- live voice (Sonic)
// The mic button opens a continuous conversation with Amazon Nova 2 Sonic:
// speech in, speech out, tool calls to the MCP server in between, barge-in.
let voiceSession: VoiceSession | undefined;
let voiceBubble: HTMLElement | undefined;

function onVoiceEvent(ev: VoiceEvent) {
  switch (ev.type) {
    case "ready":
      status.textContent = "listening… say something";
      break;
    case "transcript":
      voiceBubble = undefined;
      addUser(ev.text);
      orb.classList.add("thinking");
      break;
    case "text":
      orb.classList.remove("thinking");
      if (voiceBubble) {
        const b = voiceBubble.querySelector(".bubble")!;
        b.textContent = `${b.textContent} ${ev.text}`.trim();
        scroll();
      } else voiceBubble = addAlexa(ev.text);
      break;
    case "turn_end":
      voiceBubble = undefined;
      orb.classList.remove("thinking");
      break;
    case "interrupted":
      voiceBubble = undefined;
      break;
    case "tool_call":
      pendingArgs.set(ev.id, ev.args);
      addTool(ev.name, ev.args);
      break;
    case "tool_result": {
      const args = pendingArgs.get(ev.id) ?? {};
      pendingArgs.delete(ev.id);
      if (ev.result.isError) addTool(ev.name, { error: firstText(ev.result) }, true);
      else if (ev.uiResource) void addApp(ev.name, args, ev.result, ev.uiResource);
      break;
    }
    case "elicit":
      addElicit(ev.id, ev.message);
      break;
    case "error":
      addAlexa(`Voice: ${ev.message}`);
      break;
    case "closed":
      stopVoice();
      break;
  }
}

async function startVoice() {
  if (voiceSession) return;
  stopSpeaking();
  const session = new VoiceSession(onVoiceEvent, (speaking) => orb.classList.toggle("speaking", speaking));
  voiceSession = session;
  mic.classList.add("on");
  orb.classList.add("listening");
  try {
    await session.start();
    void loadStatus();
  } catch (err) {
    addAlexa(`Couldn't start the microphone: ${(err as Error).message}`);
    stopVoice();
  }
}

function stopVoice() {
  const s = voiceSession;
  voiceSession = undefined;
  voiceBubble = undefined;
  mic.classList.remove("on");
  orb.classList.remove("listening", "thinking", "speaking");
  s?.stop();
  void loadStatus();
}

mic.addEventListener("click", () => (voiceSession ? stopVoice() : void startVoice()));

// ------------------------------------------------------------------- turn
async function send(text: string) {
  if (busy || !text.trim()) return;
  input.value = "";
  if (voiceSession?.open) {
    // Live voice session: Sonic takes typed text too and answers aloud.
    addUser(text);
    orb.classList.add("thinking");
    voiceSession.sendText(text);
    return;
  }
  busy = true;
  stopSpeaking();
  addUser(text);
  orb.classList.add("thinking");
  const thinking = addAlexa("…", true);

  try {
    const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, text }) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let spoke = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6)) as HostEvent;
        thinking.remove();
        switch (ev.type) {
          case "text":
            addAlexa(ev.text);
            spoke = ev.text;
            break;
          case "tool_call":
            pendingArgs.set(ev.id, ev.args);
            addTool(ev.name, ev.args);
            break;
          case "tool_result": {
            const args = pendingArgs.get(ev.id) ?? {};
            pendingArgs.delete(ev.id);
            if (ev.result.isError) addTool(ev.name, { error: firstText(ev.result) }, true);
            else if (ev.uiResource) void addApp(ev.name, args, ev.result, ev.uiResource);
            break;
          }
          case "elicit":
            addElicit(ev.id, ev.message);
            break;
          case "error":
            addAlexa(`Something went wrong: ${ev.message}`);
            break;
          case "done":
            break;
        }
      }
    }
    if (spoke) void speak(spoke);
  } catch (err) {
    thinking.remove();
    addAlexa(`I couldn't reach the simulator API: ${(err as Error).message}`);
  } finally {
    busy = false;
    orb.classList.remove("thinking");
    input.focus();
  }
}

function firstText(r: CallToolResult): string {
  const t = r.content.find((c) => c.type === "text") as { text: string } | undefined;
  return t?.text ?? "unknown error";
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void send(input.value);
});
$<HTMLElement>("#suggestions").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button[data-say]") as HTMLButtonElement | null;
  if (b) void send(b.dataset.say!);
});

void loadStatus();
void loadVoices();
setInterval(() => void loadStatus(), 10_000);
