/**
 * Host side of MCP Apps: renders a tool's UI resource in a sandboxed iframe and
 * speaks the ui/* protocol with it through an AppBridge.
 */
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface AppHostCallbacks {
  /** The view wants to add a user message to the conversation (e.g. "Reorder the filter"). */
  onUserMessage: (text: string) => void;
  /** A tool called from the view returned its own visual; let the host show it too. */
  onNestedResult?: (name: string, result: CallToolResult) => void;
}

const HOST_INFO = { name: "alexa-plus-simulator", version: "0.1.0" };

/** Exposed as window.__hk for debugging the host/view handshake from devtools. */
const debug = { bridges: [] as AppBridge[], initialized: [] as string[], errors: [] as string[] };
(window as unknown as { __hk: typeof debug }).__hk = debug;

/** CSS custom properties passed to views so they match the host theme. */
const HOST_STYLE_VARS: Record<string, string> = {
  "--color-background-primary": "#16223a",
  "--color-background-secondary": "#1c2a45",
  "--color-text-primary": "#f1f5f9",
  "--color-text-secondary": "#94a3b8",
  "--color-border-primary": "#23324f",
  "--font-sans": '"Amazon Ember", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  "--border-radius-lg": "18px"
};

export async function mountApp(
  container: HTMLElement,
  html: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  result: CallToolResult,
  cb: AppHostCallbacks
): Promise<void> {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-forms");
  iframe.setAttribute("title", `${toolName} card`);
  container.appendChild(iframe);

  const bridge = new AppBridge(null, HOST_INFO, { openLinks: {}, serverTools: {}, logging: {} });
  bridge.setHostContext({
    theme: "dark",
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    platform: "web",
    styles: { variables: HOST_STYLE_VARS },
    // toolInfo.tool must be a complete MCP Tool definition or the view rejects the handshake.
    toolInfo: { id: toolName, tool: { name: toolName, inputSchema: { type: "object", properties: {} } } }
  });

  bridge.onsizechange = ({ height }) => {
    if (height) iframe.style.height = `${Math.ceil(height) + 2}px`;
  };
  bridge.onmessage = async ({ content }) => {
    const blocks = content as Array<{ type: string; text?: string }>;
    const text = blocks
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join(" ");
    if (text) cb.onUserMessage(text);
    return {};
  };
  bridge.onopenlink = async ({ url }) => {
    window.open(url, "_blank", "noopener,noreferrer");
    return {};
  };
  bridge.oncalltool = async ({ name, arguments: args }) => {
    const res = await fetch("/api/tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, arguments: args ?? {} })
    });
    const out = (await res.json()) as CallToolResult;
    cb.onNestedResult?.(name, out);
    return out;
  };
  bridge.onloggingmessage = ({ level, data }) => console.log(`[app:${toolName}] ${level}`, data);
  bridge.oninitialized = () => {
    debug.initialized.push(toolName);
    void bridge.sendToolInput({ arguments: toolArgs });
    void bridge.sendToolResult(result);
  };
  debug.bridges.push(bridge);

  // Connect the bridge before the view boots so its ui/initialize is not missed.
  // The iframe's WindowProxy is stable across the srcdoc navigation, so listening
  // on the about:blank window now still matches messages from the loaded view.
  const transport = new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!);
  transport.onerror = (err: Error) => debug.errors.push(`${toolName}: ${err.message}`);
  await bridge.connect(transport);
  iframe.srcdoc = html;
}
