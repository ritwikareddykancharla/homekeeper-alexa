import { mount, el, ICONS, say, escape } from "../shared";

interface Appliance {
  id: string;
  name: string;
  brand: string;
  model: string;
  category: string;
  categoryLabel: string;
  room?: string;
  hasManual: boolean;
  dueCount: number;
  warranty: { covered: boolean | "unknown"; expiresOn?: string; daysLeft?: number };
  consumables: Array<{ name: string }>;
}

interface Data {
  appliances: Appliance[];
}

void mount<Data>((data) => {
  const root = document.getElementById("app")!;
  root.innerHTML = "";
  const card = el("div", { class: "card" });
  card.append(el("div", { class: "eyebrow" }, el("span", { class: "dot" }), "HomeKeeper"));

  const totalDue = data.appliances.reduce((a, x) => a + (x.dueCount ?? 0), 0);
  card.append(el("h1", {}, `${data.appliances.length} appliance${data.appliances.length === 1 ? "" : "s"}`));
  card.append(
    el("p", { class: "muted" }, totalDue ? `${totalDue} maintenance item${totalDue === 1 ? "" : "s"} due in the next 30 days.` : "Everything is up to date.")
  );

  if (data.appliances.length === 0) {
    card.append(el("p", {}, "Tell me a brand and model to get started."));
    root.append(card);
    return;
  }

  const strip = el("div", { class: "carousel", role: "list" });
  for (const a of data.appliances) {
    const tile = el("div", { class: "tile", role: "listitem", tabindex: "0" });
    tile.append(el("div", { class: "icon" }, ICONS[a.category] ?? ICONS.other));
    tile.append(el("div", { class: "name" }, a.name.replace(/\b\w/, (c) => c.toUpperCase())));
    tile.append(el("div", { class: "model" }, `${a.brand} ${a.model}${a.room ? ` · ${a.room}` : ""}`));
    const foot = el("div", { class: "foot" });
    if (a.dueCount) foot.append(el("span", { class: `pill ${a.dueCount > 1 ? "warn" : "accent"}` }, `${a.dueCount} due`));
    foot.append(el("span", { class: `pill ${a.hasManual ? "ok" : ""}` }, a.hasManual ? "manual" : "no manual"));
    if (a.warranty?.covered === true) foot.append(el("span", { class: "pill ok" }, "warranty"));
    tile.append(foot);
    tile.addEventListener("click", () => void say(`What's due on the ${a.name}?`));
    tile.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void say(`What's due on the ${a.name}?`);
    });
    strip.append(tile);
  }
  card.append(strip);

  const actions = el("div", { class: "actions" });
  const due = el("button", { class: "primary" }, "What needs attention?");
  due.addEventListener("click", () => void say("What maintenance is due this month?"));
  const add = el("button", {}, "Add an appliance");
  add.addEventListener("click", () => void say("I want to register a new appliance."));
  actions.append(due, add);
  card.append(actions);
  root.append(card);
});

declare global {
  interface Window {
    __DEMO__?: unknown;
  }
}
window.__DEMO__ = {
  appliances: [
    { id: "1", name: "kitchen dishwasher", brand: "Bosch", model: "SHEM63W55N", category: "dishwasher", categoryLabel: "Dishwasher", room: "kitchen", hasManual: true, dueCount: 2, warranty: { covered: false }, consumables: [] },
    { id: "2", name: "kitchen fridge", brand: "Samsung", model: "RF28R7351SG", category: "refrigerator", categoryLabel: "Refrigerator", room: "kitchen", hasManual: true, dueCount: 1, warranty: { covered: true, daysLeft: 120 }, consumables: [] },
    { id: "3", name: "coffee maker", brand: "Keurig", model: "K-Elite", category: "coffee_maker", categoryLabel: "Coffee maker", hasManual: true, dueCount: 0, warranty: { covered: true }, consumables: [] },
    { id: "4", name: "furnace", brand: "Carrier", model: "Infinity 96", category: "hvac", categoryLabel: "HVAC", room: "basement", hasManual: false, dueCount: 1, warranty: { covered: true }, consumables: [] }
  ]
};
void escape;
