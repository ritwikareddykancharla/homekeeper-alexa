import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { resolve } from "node:path";

/**
 * Each view is built as one self-contained HTML file (scripts and styles
 * inlined) because MCP App hosts load the resource text into a sandboxed
 * iframe with no access to relative assets. The build script invokes this
 * config once per view with VIEW=<name>.
 */
const view = process.env.VIEW ?? "appliances";

export default defineConfig({
  root: resolve(__dirname, "src/views"),
  plugins: [viteSingleFile()],
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: false,
    target: "es2020",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: resolve(__dirname, `src/views/${view}.html`),
      output: { inlineDynamicImports: true }
    }
  }
});
