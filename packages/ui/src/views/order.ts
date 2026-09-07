import { mount, el, ICONS, say, callTool } from "../shared";

interface Product {
  id: string;
  title: string;
  price: number;
  currency: string;
  url: string;
  imageHint?: string;
  deliveryEstimate: string;
}

interface Data {
  status?: "quoted" | "placed" | "cancelled";
  appliance: { id: string; name: string; brand: string; model: string; category: string };
  consumable?: { id: string; name: string; partHint?: string; intervalDays: number };
  product?: Product;
  quantity?: number;
  total?: number;
  order?: { id: string };
  needsDisambiguation?: boolean;
  candidates?: Array<{ id: string; name: string }>;
  error?: string;
}

void mount<Data>((data) => {
  const root = document.getElementById("app")!;
  root.innerHTML = "";
  const card = el("div", { class: "card" });

  if (data.needsDisambiguation && data.candidates) {
    card.append(el("div", { class: "eyebrow" }, el("span", { class: "dot" }), `Which part for the ${data.appliance.name}?`));
    const actions = el("div", { class: "actions" });
    for (const c of data.candidates) {
      const b = el("button", {}, c.name);
      b.addEventListener("click", () => void say(`The ${c.name.toLowerCase()}.`));
      actions.append(b);
    }
    card.append(actions);
    root.append(card);
    return;
  }

  const { product, consumable } = data;
  if (!product || !consumable) {
    card.append(el("p", {}, data.error ?? "Nothing to order."));
    root.append(card);
    return;
  }

  const placed = data.status === "placed";
  card.append(el("div", { class: "eyebrow" }, el("span", { class: "dot" }), placed ? `Order ${data.order?.id ?? ""}` : "Reorder"));
  const head = el("div", { class: "row" });
  if (placed) head.append(el("span", { class: "check" }, "✓"));
  head.append(el("h1", { class: "grow" }, placed ? "Ordered" : `${consumable.name} for the ${data.appliance.name}`));
  card.append(head);

  const p = el("div", { class: "product" });
  p.append(el("div", { class: "thumb" }, ICONS[data.appliance.category] ?? "📦"));
  const info = el("div", {});
  info.append(el("div", { class: "title" }, product.title));
  info.append(el("div", { class: "muted" }, `${consumable.partHint ? `Part ${consumable.partHint} · ` : ""}${product.deliveryEstimate}`));
  const qty = data.quantity ?? 1;
  info.append(el("div", { class: "price" }, `$${(data.total ?? product.price * qty).toFixed(2)}${qty > 1 ? ` (${qty} × $${product.price.toFixed(2)})` : ""}`));
  p.append(info);
  card.append(p);

  const actions = el("div", { class: "actions" });
  if (data.status === "quoted") {
    const yes = el("button", { class: "primary" }, `Order ${qty > 1 ? qty + " " : ""}now`);
    yes.addEventListener("click", async () => {
      yes.disabled = true;
      yes.textContent = "Placing order…";
      try {
        await callTool("reorder_consumable", { appliance: data.appliance.id, consumable: consumable.id, quantity: qty, confirm: true });
        void say(`Confirm: I ordered the ${consumable.name.toLowerCase()} for the ${data.appliance.name}.`);
      } catch {
        void say(`Yes, order the ${consumable.name.toLowerCase()} for the ${data.appliance.name}.`);
      }
    });
    const no = el("button", {}, "Not now");
    no.addEventListener("click", () => void say("Not now."));
    actions.append(yes, no);
  } else if (placed) {
    card.append(el("p", { class: "muted", style: "margin-top:10px" }, `I'll remind you to swap the ${consumable.name.toLowerCase()} when it arrives, and again in ${Math.round(consumable.intervalDays / 30)} months.`));
    const track = el("button", {}, "View on Amazon");
    track.addEventListener("click", () => window.open(product.url, "_blank", "noopener"));
    actions.append(track);
  } else if (data.status === "cancelled") {
    card.append(el("p", { class: "muted" }, "No order placed."));
  }
  card.append(actions);
  root.append(card);
});

declare global {
  interface Window {
    __DEMO__?: unknown;
  }
}
window.__DEMO__ = {
  status: "quoted",
  appliance: { id: "2", name: "kitchen fridge", brand: "Samsung", model: "RF28R7351SG", category: "refrigerator" },
  consumable: { id: "c1", name: "Water filter", partHint: "DA29-00020B", intervalDays: 180 },
  product: { id: "B07HXNJ7WX", title: "Refrigerator Water Filter Replacement, NSF 42 Certified (2 pack)", price: 34.99, currency: "USD", url: "https://www.amazon.com/s?k=DA29-00020B", deliveryEstimate: "Tomorrow by 10 PM" },
  quantity: 1,
  total: 34.99
};
