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

  // Make the schedule feel lived-in: some tasks done recently, so not everything is overdue.
  const all = await service.listAppliances(householdId);
  const fridge = all.find((a) => a.brand === "Samsung");
  const washer = all.find((a) => a.brand === "LG");
  if (fridge) await service.logMaintenance(householdId, fridge, "Wipe door seals", "Looked fine", new Date(Date.now() - 20 * 86400000).toISOString());
  if (washer) await service.logMaintenance(householdId, washer, "Run tub clean cycle", undefined, new Date(Date.now() - 10 * 86400000).toISOString());

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
