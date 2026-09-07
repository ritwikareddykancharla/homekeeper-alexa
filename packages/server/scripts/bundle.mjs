// Produce the AgentCore Runtime direct-code-deploy artifact:
//   bundle/index.js   single-file ESM bundle (Node 22, arm64-safe: no native deps)
//   bundle/ui/*.html  MCP App views
//   bundle/package.json
// Then zip it as homekeeper-server.zip for upload to S3.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = resolve(root, "bundle");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [resolve(root, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: resolve(out, "index.js"),
  sourcemap: false,
  minify: false,
  // unpdf ships a pdf.js build that esbuild can bundle; keep AWS SDK bundled too so the zip is self-contained.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
  },
  logLevel: "info"
});

const ui = resolve(root, "../ui/dist");
if (existsSync(ui)) cpSync(ui, resolve(out, "ui"), { recursive: true });
else console.warn("[bundle] UI views not built; cards will be placeholders.");

writeFileSync(resolve(out, "package.json"), JSON.stringify({ name: "homekeeper-server", type: "module", version: "0.1.0" }, null, 2));

const zip = resolve(root, "homekeeper-server.zip");
rmSync(zip, { force: true });
execSync(`cd "${out}" && zip -qr "${zip}" .`, { stdio: "inherit" });
console.log(`[bundle] wrote ${zip}`);
