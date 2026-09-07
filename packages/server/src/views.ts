import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VIEW_NAMES = ["appliances", "troubleshoot", "maintenance", "order"] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

export const viewUri = (name: ViewName) => `ui://homekeeper/${name}.html`;

/**
 * MCP App views are single-file HTML bundles built by packages/ui. The server
 * looks for them in (first match wins):
 *   $UI_DIST_DIR
 *   <this file>/ui            (bundled deployment layout)
 *   <repo>/packages/ui/dist   (local development)
 */
export function loadViews(): Record<ViewName, string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.UI_DIST_DIR, join(here, "ui"), resolve(here, "../../ui/dist"), resolve(here, "../../../ui/dist")].filter(
    (p): p is string => Boolean(p)
  );
  const dir = candidates.find((d) => existsSync(join(d, "appliances.html")));
  const out = {} as Record<ViewName, string>;
  for (const name of VIEW_NAMES) {
    const file = dir ? join(dir, `${name}.html`) : undefined;
    out[name] =
      file && existsSync(file)
        ? readFileSync(file, "utf8")
        : `<!doctype html><html><body style="font-family:system-ui;padding:16px"><p>HomeKeeper view <code>${name}</code> is not built. Run <code>npm run build -w @homekeeper/ui</code>.</p></body></html>`;
  }
  if (!dir) console.warn("[views] UI bundle not found; serving placeholder views. Looked in:", candidates.join(", "));
  return out;
}
