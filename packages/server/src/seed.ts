import type { HomeKeeperService } from "./service.js";

/**
 * Seed a realistic demo household. Idempotent: skips if appliances exist.
 * Purchase dates are staggered so maintenance_due shows overdue, due-soon, and
 * upcoming items out of the box.
 */
export async function seedDemoHousehold(service: HomeKeeperService, householdId: string): Promise<number> {
  const existing = await service.listAppliances(householdId);
  if (existing.length > 0) return 0;

  const monthsAgo = (m: number) => {
    const d = new Date();
    d.setMonth(d.getMonth() - m);
    return d.toISOString().slice(0, 10);
  };

  const seeds = [
    { brand: "Bosch", model: "SHEM63W55N", name: "kitchen dishwasher", room: "kitchen", purchaseDate: monthsAgo(14), serial: "FD9812 004532" },
    { brand: "Samsung", model: "RF28R7351SG", name: "kitchen fridge", room: "kitchen", purchaseDate: monthsAgo(7) },
    { brand: "Keurig", model: "K-Elite", name: "coffee maker", room: "kitchen", purchaseDate: monthsAgo(4) },
    { brand: "LG", model: "WM4000HWA", name: "washer", room: "laundry room", purchaseDate: monthsAgo(2) },
    { brand: "Carrier", model: "Infinity 96", name: "furnace", room: "basement", category: "hvac" as const, purchaseDate: monthsAgo(40), warrantyMonths: 120 }
  ];

  for (const s of seeds) await service.registerAppliance(householdId, s);

  // Make the schedule feel lived-in. Log recent maintenance so the timeline shows a
  // believable mix: a couple overdue, a few due soon, most fine.
  const all = await service.listAppliances(householdId);
  const by = (brand: string) => all.find((a) => a.brand === brand);
  const ago = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
  const done: Array<[string, string, number]> = [
    // dishwasher: filter due in ~3 days (30d interval), rest fine
    ["Bosch", "Clean the filter", 27],
    ["Bosch", "Run a cleaning cycle", 20],
    ["Bosch", "Check and wipe door gasket", 40],
    ["Bosch", "Inspect spray arms", 60],
    // fridge: water filter 12 days overdue (180d interval), coils due in ~3 weeks
    ["Samsung", "Replace water filter", 192],
    ["Samsung", "Clean condenser coils", 160],
    ["Samsung", "Wipe door seals", 20],
    ["Samsung", "Replace air filter", 100],
    // coffee maker: descale due in ~3 weeks (90d)
    ["Keurig", "Descale", 70],
    ["Keurig", "Replace water filter", 30],
    // washer: all recent
    ["LG", "Run tub clean cycle", 10],
    ["LG", "Clean drain pump filter", 45],
    ["LG", "Wipe door gasket", 5],
    ["LG", "Inspect hoses", 100],
    // furnace: air filter 5 days overdue (90d), tune-up done last season
    ["Carrier", "Replace air filter", 95],
    ["Carrier", "Professional tune-up", 200],
    ["Carrier", "Clear outdoor condenser", 100]
  ];
  for (const [brand, task, days] of done) {
    const a = by(brand);
    if (a) await service.logMaintenance(householdId, a, task, undefined, ago(days));
  }

  return seeds.length;
}

// Allow `npm run seed` for a one-off seed of the configured store.
if (process.argv[1]?.endsWith("seed.ts") || process.argv[1]?.endsWith("seed.js")) {
  const [{ createStoreFromEnv }, { createAiFromEnv }, { HomeKeeperService }] = await Promise.all([
    import("./store/index.js"),
    import("./ai/bedrock.js"),
    import("./service.js")
  ]);
  const store = await createStoreFromEnv();
  const service = new HomeKeeperService(store, createAiFromEnv());
  const n = await seedDemoHousehold(service, process.env.HOUSEHOLD_ID ?? "demo-home");
  if ("flush" in store && typeof (store as { flush?: () => Promise<void> }).flush === "function") await (store as { flush: () => Promise<void> }).flush();
  console.log(n ? `Seeded ${n} appliances.` : "Household already has appliances; nothing to do.");
}
