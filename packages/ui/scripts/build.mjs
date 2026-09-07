import { build } from "vite";
import { rmSync, renameSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = resolve(root, "dist");
const views = ["appliances", "troubleshoot", "maintenance", "order"];

rmSync(dist, { recursive: true, force: true });

for (const view of views) {
  process.env.VIEW = view;
  await build({ configFile: resolve(root, "vite.config.ts"), logLevel: "warn" });
  // Vite emits <name>.html at the root of outDir for a single html input.
  const out = resolve(dist, `${view}.html`);
  if (!existsSync(out)) {
    const html = readdirSync(dist).find((f) => f.endsWith(".html") && !views.some((v) => f === `${v}.html`));
    if (html) renameSync(resolve(dist, html), out);
  }
  console.log(`[ui] built ${view}.html`);
}
