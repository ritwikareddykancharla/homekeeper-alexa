import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./src/web", import.meta.url));

export default defineConfig({
  root,
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
      "/ws": { target: "ws://localhost:3001", ws: true }
    }
  }
});
