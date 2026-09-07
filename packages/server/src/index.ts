import { createStoreFromEnv } from "./store/index.js";
import { createAiFromEnv } from "./ai/bedrock.js";
import { HomeKeeperService } from "./service.js";
import { createMcpServer } from "./mcp.js";
import { loadViews } from "./views.js";
import { createHttpServer } from "./http.js";
import { seedDemoHousehold } from "./seed.js";

const port = Number(process.env.PORT ?? 3000);
const stateless = process.env.MCP_STATELESS === "1";

const store = await createStoreFromEnv();
const ai = createAiFromEnv();
const service = new HomeKeeperService(store, ai);
const views = loadViews();

if (process.env.SEED_DEMO === "1") {
  const n = await seedDemoHousehold(service, process.env.HOUSEHOLD_ID ?? "demo-home");
  if (n) console.log(`[seed] created ${n} demo appliances`);
}

const http = createHttpServer({
  createServer: () => createMcpServer({ service, views, defaultHouseholdId: process.env.HOUSEHOLD_ID }),
  stateless,
  log: (m) => console.log(`[mcp] ${m}`)
});

await http.listen(port);
console.log(`HomeKeeper MCP server listening on http://0.0.0.0:${port}/mcp (${stateless ? "stateless" : "stateful"}, bedrock ${ai.enabled ? "on" : "off"})`);

const shutdown = async () => {
  await http.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
