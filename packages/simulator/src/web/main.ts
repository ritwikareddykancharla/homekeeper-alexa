import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mountApp } from "./apps.js";

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

const sessionId = crypto.randomUUID();
const pendingArgs = new Map<string, Record<string, unknown>>();
const toolUi = new Map<string, string>();
let busy = false;

// ----------------------------------------------------------------- status
async function loadStatus() {
  try {
    const s = (await (await fetch("/api/status")).json()) as { tools: string[]; toolUi: Record<string, string>; mcpUrl: string; auth: string; model: string; mode: string };
    for (const [k, v] of Object.entries(s.toolUi ?? {})) toolUi.set(k, v);
    const target = s.mcpUrl.includes("bedrock-agentcore") ? "AgentCore Runtime" : s.mcpUrl;
    const brain = s.mode === "rules" ? "rules mode (no Bedrock)" : s.model.replace(/^[a-z]{2}\./, "").split(".").slice(-1)[0].split("-").slice(0, 3).join(" ");
    status.textContent = `${s.tools.length} tools · ${target} · ${s.auth} · ${brain}`;
    status.classList.toggle("err", s.tools.length === 0);
    if (s.tools.length === 0) status.textContent = "MCP server unreachable (is it running on :3000?)";
  } catch {
    status.textContent = "simulator API unreachable";
    status.classList.add("err");
  }
}

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
  speak(message);
}

// ------------------------------------------------------------------ voice
function speak(text: string) {
  if (!tts.checked || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  const voices = speechSynthesis.getVoices();
  u.voice = voices.find((v) => /Samantha|Google US English|Karen|Moira/.test(v.name)) ?? voices.find((v) => v.lang.startsWith("en")) ?? null;
  u.onstart = () => orb.classList.add("speaking");
  u.onend = () => orb.classList.remove("speaking");
  speechSynthesis.speak(u);
}

type SR = { start(): void; stop(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; lang: string; interimResults: boolean };
const SpeechRecognitionCtor = (window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SR }).webkitSpeechRecognition;
let recognizer: SR | undefined;
mic.addEventListener("click", () => {
  if (!SpeechRecognitionCtor) {
    alert("Speech recognition isn't available in this browser. Type instead.");
    return;
  }
  if (recognizer) {
    recognizer.stop();
    return;
  }
  recognizer = new SpeechRecognitionCtor();
  recognizer.lang = "en-US";
  recognizer.interimResults = false;
  mic.classList.add("on");
  orb.classList.add("listening");
  recognizer.onresult = (e) => {
    const text = e.results[0][0].transcript;
    void send(text);
  };
  recognizer.onend = () => {
    mic.classList.remove("on");
    orb.classList.remove("listening");
    recognizer = undefined;
  };
  recognizer.start();
});

// ------------------------------------------------------------------- turn
async function send(text: string) {
  if (busy || !text.trim()) return;
  busy = true;
  input.value = "";
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
    if (spoke) speak(spoke);
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
