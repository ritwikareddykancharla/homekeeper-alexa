import { mount, el, ICONS, say, relDays, callTool } from "../shared";

interface Item {
  taskId: string;
  title: string;
  instructions?: string;
  nextDue: string;
  lastDone?: string;
  daysUntilDue: number;
  status: "overdue" | "due_soon" | "upcoming";
  consumableId: string | null;
  appliance: { id: string; name: string; brand: string; category: string };
}

interface Data {
  withinDays: number;
  items: Item[];
}

void mount<Data>((data) => {
  const root = document.getElementById("app")!;
  root.innerHTML = "";
  const card = el("div", { class: "card" });
  card.append(el("div", { class: "eyebrow" }, el("span", { class: "dot" }), "Maintenance"));

  const overdue = data.items.filter((i) => i.status === "overdue").length;
  const soon = data.items.filter((i) => i.status === "due_soon").length;
  card.append(el("h1", {}, data.items.length ? `${data.items.length} item${data.items.length === 1 ? "" : "s"} in the next ${data.withinDays} days` : "All caught up"));
  const badges = el("div", { class: "badge-row" });
  if (overdue) badges.append(el("span", { class: "pill danger" }, `${overdue} overdue`));
  if (soon) badges.append(el("span", { class: "pill warn" }, `${soon} this week`));
  if (!overdue && !soon && data.items.length) badges.append(el("span", { class: "pill ok" }, "nothing urgent"));
  card.append(badges);

  const list = el("div", { class: "timeline" });
  for (const it of data.items) {
    const row = el("div", { class: `tl-item ${it.status}` });
    row.append(el("div", { class: "bar" }));
    const body = el("div", {});
    body.append(el("div", { class: "title" }, `${ICONS[it.appliance.category] ?? ""} ${it.title}`));
    body.append(el("div", { class: "sub" }, `${it.appliance.name}${it.instructions ? ` · ${it.instructions.split(/(?<=\.)\s/)[0]}` : ""}`));
    const btns = el("div", { class: "actions", style: "margin-top:8px" });
    const done = el("button", {}, "Done");
    done.addEventListener("click", async () => {
      done.disabled = true;
      done.textContent = "Logging…";
      try {
        await callTool("log_maintenance", { appliance: it.appliance.id, task: it.taskId });
        row.classList.remove("overdue", "due_soon");
        row.classList.add("upcoming");
        row.querySelector(".when")!.textContent = "done today";
        done.textContent = "Logged";
      } catch {
        done.textContent = "Done";
        done.disabled = false;
        void say(`I just did "${it.title}" on the ${it.appliance.name}.`);
      }
    });
    btns.append(done);
    if (it.consumableId) {
      const order = el("button", { class: "primary" }, "Reorder part");
      order.addEventListener("click", () => void say(`Reorder the part for "${it.title}" on the ${it.appliance.name}.`));
      btns.append(order);
    }
    body.append(btns);
    row.append(body);
    row.append(el("div", { class: "when" }, relDays(it.daysUntilDue)));
    list.append(row);
  }
  card.append(list);
  root.append(card);
});

declare global {
  interface Window {
    __DEMO__?: unknown;
  }
}
const d = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
window.__DEMO__ = {
  withinDays: 30,
  items: [
    { taskId: "t1", title: "Replace water filter", instructions: "Twist to release, insert new filter, flush 2 gallons.", nextDue: d(-12), daysUntilDue: -12, status: "overdue", consumableId: "c1", appliance: { id: "2", name: "kitchen fridge", brand: "Samsung", category: "refrigerator" } },
    { taskId: "t2", title: "Clean the filter", instructions: "Remove lower rack, twist out the filter, rinse.", nextDue: d(3), daysUntilDue: 3, status: "due_soon", consumableId: null, appliance: { id: "1", name: "kitchen dishwasher", brand: "Bosch", category: "dishwasher" } },
    { taskId: "t3", title: "Descale", instructions: "Run the descaling program.", nextDue: d(18), daysUntilDue: 18, status: "upcoming", consumableId: "c2", appliance: { id: "3", name: "coffee maker", brand: "Keurig", category: "coffee_maker" } }
  ]
};
