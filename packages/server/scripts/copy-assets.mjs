// Copy built MCP App views next to the compiled server so `node dist/index.js`
// finds them without the monorepo layout.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../ui/dist");
const dst = resolve(here, "../dist/ui");

if (existsSync(src)) {
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log(`[copy-assets] copied UI views to ${dst}`);
} else {
  console.warn("[copy-assets] packages/ui/dist not found; build the UI first for rich cards.");
}
