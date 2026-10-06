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
/** "us.anthropic.claude-sonnet-4-5-20250929-v1:0" -> "Claude Sonnet 4.5" */
function modelName(id: string): string {
  const parts = id.replace(/^[a-z]{2}\./, "").split(".").slice(-1)[0].split("-");
  const words = parts.filter((p) => /^[a-z]+$/i.test(p)).map((p) => p[0].toUpperCase() + p.slice(1));
  const nums = parts.filter((p) => /^\d$/.test(p));
  return `${words.join(" ")} ${nums.join(".")}`.trim();
}

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
    const brain = s.mode === "rules" ? "rules, no Bedrock" : modelName(s.model);
    const voice = voiceSession ? `, live with Nova 2 Sonic and ${s.voice?.speaker ?? "Polly"}` : s.tts ? `, spoken by Polly ${s.tts.voice}` : "";
    const where = target === "AgentCore Runtime" ? "on AgentCore Runtime" : "locally";
    status.textContent = `HomeKeeper is running ${where} with ${s.tools.length} tools. Reasoning with ${brain}${voice}.`;
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
    // Shortlist from a side-by-side listen: warmest and most natural of the generative voices.
    const PICKS = ["Ruth", "Matthew", "Stephen"];
    const picks = document.createElement("optgroup");
    picks.label = "picks";
    for (const id of PICKS) {
      const vo = v.voices.find((x) => x.engine === "generative" && x.id === id);
      if (!vo) continue;
      const o = document.createElement("option");
      o.value = `generative:${vo.id}`;
      o.textContent = `${vo.name} (${vo.gender[0] ?? ""})`;
      picks.appendChild(o);
    }
    if (picks.children.length) voicePick.appendChild(picks);
    const label: Record<string, string> = { generative: "all generative", "long-form": "long-form", neural: "neural (older engine)" };
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
    chosenVoice = voicePick.value;
  } catch {
    voicePick.hidden = true;
  }
}

let chosenVoice = "";
voicePick.addEventListener("focus", () => {
  chosenVoice = voicePick.value;
});
voicePick.addEventListener("change", async () => {
  const [engine, voice] = voicePick.value.split(":");
  const res = await fetch("/api/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ voice, engine }) });
  if (!res.ok) {
    // The server already put the previous voice back; mirror that in the picker and say what went wrong.
    if (chosenVoice) voicePick.value = chosenVoice;
    status.textContent = ((await res.json()) as { error: string }).error;
    status.classList.add("err");
    return;
  }
  chosenVoice = voicePick.value;
  status.classList.remove("err");
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
    .map(([k, v]) => `${k} ${typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v)}`)
    .join(", ");
  el.innerHTML = `<span>${err ? "HomeKeeper could not run" : "HomeKeeper ran"}</span><code></code><span></span>`;
  el.querySelector("code")!.textContent = name;
  el.querySelectorAll("span")[1]!.textContent = summary ? `with ${summary}` : "";
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

/**
 * Speak with Amazon Polly via the API. If Polly cannot speak this reply, say
 * why in the status line and use the browser voice for this reply only; the
 * next reply tries Polly again.
 */
async function speak(text: string) {
  if (!tts.checked) return;
  stopSpeaking();
  try {
    const res = await fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!res.ok) {
      const why = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
      throw new Error(why);
    }
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
    console.warn("Polly could not speak this reply:", err);
    status.textContent = `Polly could not speak this reply (${(err as Error).message}). Using the browser voice.`;
    status.classList.add("err");
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
      status.textContent = "Listening";
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
