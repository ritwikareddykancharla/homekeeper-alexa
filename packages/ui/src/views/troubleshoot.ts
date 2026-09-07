import { mount, el, ICONS, say } from "../shared";

interface Data {
  appliance: { id: string; name: string; brand: string; model: string; category: string };
  question: string;
  answer: string;
  steps: string[];
  grounded: boolean;
  manual: { id: string; title: string } | null;
  sources: Array<{ section?: string; page?: number; excerpt: string; score: number }>;
  suggestReorder: { consumableId: string; name: string } | null;
  needsDisambiguation?: boolean;
  candidates?: Array<{ id: string; name: string; brand: string; model: string }>;
}

void mount<Data>((data) => {
  const root = document.getElementById("app")!;
  root.innerHTML = "";
  const card = el("div", { class: "card" });

  if (data.needsDisambiguation && data.candidates) {
    card.append(el("div", { class: "eyebrow" }, el("span", { class: "dot" }), "Which one?"));
    const actions = el("div", { class: "actions" });
    for (const c of data.candidates) {
      const b = el("button", {}, `${ICONS[(c as { category?: string }).category ?? "other"] ?? ""} ${c.name}`);
      b.addEventListener("click", () => void say(`I mean the ${c.name}.`));
      actions.append(b);
    }
    card.append(actions);
    root.append(card);
    return;
  }

  card.append(el("div", { class: "eyebrow" }, el("span", { class: "dot" }), `${data.appliance.brand} ${data.appliance.model}`));
  card.append(el("h1", {}, `${ICONS[data.appliance.category] ?? ""} ${data.question}`));
  card.append(el("p", {}, data.answer));

  if (data.steps?.length) {
    const ol = el("ol", { class: "steps" });
    for (const s of data.steps) ol.append(el("li", {}, el("span", {}, s)));
    card.append(ol);
  }

  if (data.sources?.length) {
    const s = data.sources[0];
    const box = el("div", { class: "source" });
    box.append(el("div", { class: "label" }, `From ${data.manual?.title ?? "the manual"}${s.section ? ` · ${s.section}` : ""}${s.page ? ` · p.${s.page}` : ""}`));
    box.append(document.createTextNode(s.excerpt.replace(/\|/g, " · ").replace(/\n{2,}/g, "\n")));
    card.append(box);
  } else if (!data.grounded) {
    card.append(el("p", { class: "muted" }, "No manual on file for this appliance. Say \"add the manual\" with a link and I'll read it."));
  }

  const actions = el("div", { class: "actions" });
  if (data.suggestReorder) {
    const b = el("button", { class: "primary" }, `Reorder ${data.suggestReorder.name.toLowerCase()}`);
    b.addEventListener("click", () => void say(`Reorder the ${data.suggestReorder!.name.toLowerCase()} for the ${data.appliance.name}.`));
    actions.append(b);
  }
  const fixed = el("button", {}, "That fixed it");
  fixed.addEventListener("click", () => void say(`That fixed the ${data.appliance.name}. Log it as done.`));
  const more = el("button", {}, "Didn't help");
  more.addEventListener("click", () => void say(`That didn't help with the ${data.appliance.name}. What else could it be?`));
  actions.append(fixed, more);
  card.append(actions);
  root.append(card);
});

declare global {
  interface Window {
    __DEMO__?: unknown;
  }
}
window.__DEMO__ = {
  appliance: { id: "1", name: "kitchen dishwasher", brand: "Bosch", model: "SHEM63W55N", category: "dishwasher" },
  question: "The dishwasher is showing E24",
  answer: "E24 is a drain error: water isn't leaving the tub. It's usually a kinked drain hose or a clogged filter.",
  steps: ["Check the drain hose for kinks.", "Clean the filter.", "Confirm the drain connection at the sink or disposal isn't blocked.", "Run Rinse & Hold to test."],
  grounded: true,
  manual: { id: "m1", title: "Bosch 300 Series Owner's Guide" },
  sources: [{ section: "Troubleshooting", page: 17, excerpt: "E24 | Drain error: water is not draining | Check the drain hose for kinks. Clean the filter. Confirm the drain hose connection at the sink or disposal is not blocked.", score: 1 }],
  suggestReorder: { consumableId: "c1", name: "Dishwasher cleaner" }
};
