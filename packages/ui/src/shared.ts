import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const app = new App({ name: "homekeeper-view", version: "0.1.0" });

function applyContext(ctx: McpUiHostContext | undefined) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

/**
 * Connect to the host and wire up tool result handling. `render` receives the
 * tool's structuredContent (falling back to parsing the first text block).
 */
export async function mount<T>(render: (data: T, result: CallToolResult) => void) {
  const root = document.getElementById("app")!;
  const show = (result: CallToolResult) => {
    let data = result.structuredContent as T | undefined;
    if (!data) {
      const text = result.content.find((c) => c.type === "text");
      if (text && text.type === "text") {
        try {
          data = JSON.parse(text.text) as T;
        } catch {
          data = undefined;
        }
      }
    }
    if (result.isError || !data) {
      root.innerHTML = `<div class="card error"><p>${escape(result.content.map((c) => (c.type === "text" ? c.text : "")).join(" ") || "Something went wrong.")}</p></div>`;
      return;
    }
    render(data, result);
  };

  app.ontoolresult = (params) => show(params);
  app.onhostcontextchanged = (ctx) => applyContext({ ...app.getHostContext(), ...ctx } as McpUiHostContext);
  app.ontoolcancelled = () => {
    root.innerHTML = `<div class="card muted"><p>Cancelled.</p></div>`;
  };

  // Development preview: open the built HTML directly with ?demo=1 (no host) to render fixture data.
  const params = new URLSearchParams(location.search);
  if (params.get("demo")) {
    if (params.get("theme")) document.documentElement.dataset.theme = params.get("theme")!;
    // Views set window.__DEMO__ after calling mount(), so defer one tick.
    queueMicrotask(() => {
      const fixture = (window as unknown as { __DEMO__?: Record<string, unknown> }).__DEMO__;
      if (fixture) show({ content: [], structuredContent: fixture });
    });
    return;
  }

  await app.connect();
  applyContext(app.getHostContext());
}

export function escape(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

/** Ask the host to send a follow-up user message (e.g. "reorder the fridge filter"). */
export async function say(text: string) {
  try {
    await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
  } catch (err) {
    console.warn("sendMessage not supported by host", err);
  }
}

/** Call a server tool directly from the view and re-render with the result. */
export async function callTool(name: string, args: Record<string, unknown>) {
  return app.callServerTool({ name, arguments: args });
}

export const ICONS: Record<string, string> = {
  dishwasher: "🍽️",
  refrigerator: "🧊",
  washer: "🫧",
  dryer: "🌀",
  hvac: "🌡️",
  water_heater: "🔥",
  range_oven: "🍳",
  microwave: "📡",
  coffee_maker: "☕",
  water_filter: "💧",
  robot_vacuum: "🤖",
  air_purifier: "🍃",
  garbage_disposal: "🗑️",
  smoke_detector: "🚨",
  other: "🏠"
};

export function relDays(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days < 0) return `${-days} days overdue`;
  if (days < 14) return `in ${days} days`;
  if (days < 60) return `in ${Math.round(days / 7)} weeks`;
  return `in ${Math.round(days / 30)} months`;
}
