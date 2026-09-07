import { randomUUID } from "node:crypto";
import type { HouseholdStore } from "./store/index.js";
import type { AiProvider } from "./ai/bedrock.js";
import { CATALOG, detectCategory, type CatalogTask } from "./knowledge/catalog.js";
import { findBundledManual } from "./knowledge/manuals/index.js";
import { chunkText, retrieve, type RetrievedChunk } from "./knowledge/retrieval.js";
import { findProduct } from "./knowledge/products.js";
import type {
  Appliance,
  ApplianceCategory,
  Consumable,
  MaintenanceLog,
  MaintenanceTask,
  Manual,
  ManualChunk,
  Order
} from "./types.js";

const DAY = 86_400_000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (from: string | Date, days: number) => isoDate(new Date(new Date(from).getTime() + days * DAY));

export interface RegisterInput {
  name?: string;
  brand: string;
  model: string;
  category?: ApplianceCategory;
  room?: string;
  purchaseDate?: string;
  warrantyMonths?: number;
  serial?: string;
  notes?: string;
}

export interface TroubleshootResult {
  appliance: Appliance;
  answer: string;
  steps: string[];
  sources: RetrievedChunk[];
  manual?: Manual;
  grounded: boolean;
  suggestReorder?: { consumableId: string; name: string };
}

export interface DueItem {
  task: MaintenanceTask;
  appliance: Appliance;
  daysUntilDue: number; // negative = overdue
  status: "overdue" | "due_soon" | "upcoming";
}

/**
 * HomeKeeperService holds the business logic behind every MCP tool. Tools stay
 * thin (validate, call service, format), which keeps the logic testable
 * without a transport.
 */
export class HomeKeeperService {
  constructor(
    private readonly store: HouseholdStore,
    private readonly ai: AiProvider,
    private readonly now: () => Date = () => new Date()
  ) {}

  // ---------------------------------------------------------------- appliances

  async listAppliances(householdId: string) {
    return this.store.listAppliances(householdId);
  }

  /**
   * Find an appliance by fuzzy reference ("the dishwasher", "kitchen fridge",
   * "Bosch"). Returns all candidates so the caller can elicit when ambiguous.
   */
  async resolveAppliance(householdId: string, ref: string): Promise<Appliance[]> {
    const all = await this.store.listAppliances(householdId);
    const r = ref.trim().toLowerCase();
    if (!r) return all;
    const exact = all.find((a) => a.id === ref || a.name.toLowerCase() === r);
    if (exact) return [exact];
    const cat = detectCategory(r);
    const scored = all
      .map((a) => {
        let s = 0;
        const hay = `${a.name} ${a.brand} ${a.model} ${a.room ?? ""} ${CATALOG[a.category].label}`.toLowerCase();
        for (const w of r.split(/\s+/)) if (w.length > 2 && hay.includes(w)) s += 2;
        if (cat !== "other" && a.category === cat) s += 3;
        if (a.room && r.includes(a.room.toLowerCase())) s += 2;
        return { a, s };
      })
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s);
    if (scored.length === 0) return [];
    const top = scored[0].s;
    return scored.filter((x) => x.s >= top - 1).map((x) => x.a);
  }

  async registerAppliance(householdId: string, input: RegisterInput): Promise<{ appliance: Appliance; tasks: MaintenanceTask[]; manual?: Manual }> {
    let category = input.category ?? detectCategory(`${input.brand} ${input.model} ${input.name ?? ""} ${input.notes ?? ""}`);
    if (category === "other") {
      // A recognised model number tells us the category even when the user didn't say "dishwasher".
      const known = findBundledManual(input.brand, input.model);
      if (known) category = known.category as ApplianceCategory;
    }
    const entry = CATALOG[category];
    const now = this.now().toISOString();
    const id = randomUUID().slice(0, 8);
    const name = input.name ?? `${input.room ? input.room + " " : ""}${entry.label.toLowerCase()}`.trim();

    const plan = await this.deriveSchedule(input.brand, input.model, category, entry.tasks);

    const consumables: Consumable[] = [];
    const tasks: MaintenanceTask[] = [];
    const anchor = input.purchaseDate ?? isoDate(this.now());
    for (const t of plan.tasks) {
      let consumableId: string | undefined;
      if (t.consumable) {
        const c: Consumable = {
          id: randomUUID().slice(0, 6),
          name: t.consumable.name,
          partHint: t.consumable.partHint,
          intervalDays: t.intervalDays,
          productQuery: t.consumable.productQuery
        };
        consumables.push(c);
        consumableId = c.id;
      }
      tasks.push({
        id: randomUUID().slice(0, 8),
        householdId,
        applianceId: id,
        title: t.title,
        intervalDays: t.intervalDays,
        instructions: t.instructions,
        consumableId,
        nextDue: addDays(anchor, t.intervalDays),
        source: plan.source
      });
    }

    const appliance: Appliance = {
      id,
      householdId,
      name,
      brand: input.brand,
      model: input.model,
      category,
      room: input.room,
      purchaseDate: input.purchaseDate,
      warrantyMonths: input.warrantyMonths ?? entry.defaultWarrantyMonths,
      serial: input.serial,
      consumables,
      notes: input.notes,
      createdAt: now,
      updatedAt: now
    };

    await this.store.putAppliance(appliance);
    for (const t of tasks) await this.store.putTask(t);

    // Auto-attach a bundled manual when we recognise the model.
    let manual: Manual | undefined;
    const bundled = findBundledManual(input.brand, input.model, category);
    if (bundled) {
      manual = await this.ingestManualText(householdId, appliance, bundled.title, `bundled:${bundled.key}`, bundled.text);
    }
    return { appliance, tasks, manual };
  }

  async removeAppliance(householdId: string, id: string) {
    await this.store.deleteTasksForAppliance(householdId, id);
    await this.store.deleteAppliance(householdId, id);
  }

  /**
   * Derive a maintenance plan. Baseline from the catalog; Bedrock (when
   * available) adjusts intervals and adds model-specific part hints.
   */
  private async deriveSchedule(
    brand: string,
    model: string,
    category: ApplianceCategory,
    baseline: CatalogTask[]
  ): Promise<{ tasks: Array<CatalogTask & { consumable?: CatalogTask["consumable"] & { partHint?: string } }>; source: "catalog" | "ai" }> {
    const system =
      "You are an appliance maintenance expert. Given an appliance and a baseline schedule, return refined JSON only. " +
      "Keep the same tasks unless the model clearly does not have that component. Add a `partHint` (manufacturer part number or filter type) " +
      "to consumables when you are confident. Adjust intervalDays only when the manufacturer recommends differently. " +
      'Respond as {"tasks":[{"title":string,"intervalDays":number,"instructions":string,"consumable":{"name":string,"productQuery":string,"partHint":string}|null}]}';
    const user = `Appliance: ${brand} ${model} (${CATALOG[category].label})\nBaseline: ${JSON.stringify(baseline)}`;
    const raw = await this.ai.complete(system, user, { json: true, maxTokens: 1500 });
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { tasks?: Array<Record<string, unknown>> };
        const tasks = (parsed.tasks ?? [])
          .filter((t) => typeof t.title === "string" && typeof t.intervalDays === "number")
          .map((t) => {
            const c = t.consumable as { name?: string; productQuery?: string; partHint?: string } | null | undefined;
            return {
              title: String(t.title),
              intervalDays: Math.max(1, Math.round(Number(t.intervalDays))),
              instructions: typeof t.instructions === "string" ? t.instructions : "",
              consumable:
                c && typeof c.name === "string"
                  ? { name: c.name, productQuery: c.productQuery ?? c.name, partHint: c.partHint || undefined }
                  : undefined
            };
          });
        if (tasks.length > 0) return { tasks, source: "ai" };
      } catch {
        // fall through to baseline
      }
    }
    return { tasks: baseline, source: "catalog" };
  }

  // ------------------------------------------------------------------- manuals

  async ingestManualText(householdId: string, appliance: Appliance, title: string, source: string, text: string): Promise<Manual> {
    const chunks = chunkText(text);
    const vectors = await this.ai.embed(chunks.map((c) => `${c.section ?? ""}\n${c.text}`));
    const withVec: ManualChunk[] = chunks.map((c, i) => (vectors ? { ...c, embedding: vectors[i] } : c));
    const manual: Manual = {
      id: randomUUID().slice(0, 8),
      householdId,
      applianceId: appliance.id,
      title,
      source,
      chunkCount: chunks.length,
      ingestedAt: this.now().toISOString()
    };
    await this.store.putManual(manual, withVec);
    appliance.manualId = manual.id;
    appliance.updatedAt = this.now().toISOString();
    await this.store.putAppliance(appliance);
    return manual;
  }

  async ingestManualFromUrl(householdId: string, appliance: Appliance, url: string, title?: string): Promise<Manual> {
    const res = await fetch(url, { headers: { "user-agent": "HomeKeeper/0.1 (+https://github.com/ritwikareddykancharla/homekeeper-alexa)" } });
    if (!res.ok) throw new Error(`Could not download manual: HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    let text: string;
    if (type.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const buf = new Uint8Array(await res.arrayBuffer());
      const pdf = await getDocumentProxy(buf);
      const { text: pages } = await extractText(pdf, { mergePages: false });
      text = (pages as string[]).map((p, i) => `[[page ${i + 1}]]\n${p}`).join("\n\n");
    } else {
      text = (await res.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ");
    }
    if (text.trim().length < 200) throw new Error("The document had almost no extractable text.");
    return this.ingestManualText(householdId, appliance, title ?? `${appliance.brand} ${appliance.model} manual`, url, text);
  }

  // ------------------------------------------------------------ troubleshooting

  async troubleshoot(householdId: string, appliance: Appliance, question: string): Promise<TroubleshootResult> {
    const manual = appliance.manualId ? await this.store.getManual(householdId, appliance.manualId) : undefined;
    const chunks = manual ? await this.store.getManualChunks(householdId, manual.id) : [];
    const sources = await retrieve(this.ai, question, chunks, 4);
    const grounded = sources.length > 0;

    let answer: string | undefined;
    let steps: string[] = [];

    if (this.ai.enabled) {
      const system =
        "You are HomeKeeper, a calm and precise home appliance assistant speaking through Alexa. " +
        "Answer using ONLY the provided manual excerpts when they are relevant; if they are not, say what general step to try and that the manual does not cover it. " +
        "Be brief: 2 to 4 spoken sentences, then a short numbered list of concrete steps. Never invent error code meanings. " +
        'Return JSON: {"answer": string, "steps": string[]}';
      const ctx = sources.map((s, i) => `[${i + 1}] (${s.section ?? "manual"}${s.page ? `, p.${s.page}` : ""}) ${s.text}`).join("\n\n");
      const user = `Appliance: ${appliance.brand} ${appliance.model} (${CATALOG[appliance.category].label}) in ${appliance.room ?? "the home"}\nQuestion: ${question}\n\nManual excerpts:\n${ctx || "(none available)"}`;
      const raw = await this.ai.complete(system, user, { json: true, maxTokens: 700 });
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { answer?: string; steps?: string[] };
          answer = parsed.answer;
          steps = Array.isArray(parsed.steps) ? parsed.steps.map(String) : [];
        } catch {
          answer = raw.replace(/^\{|\}$/g, "");
        }
      }
    }

    if (!answer) {
      // Rule-based fallback: surface the best excerpt directly.
      if (sources.length > 0) {
        const best = sources[0];
        const row = extractTableRow(best.text, question);
        answer = row
          ? `According to the ${appliance.brand} manual${best.page ? ` (page ${best.page})` : ""}: ${row.meaning}.`
          : `Here is what the ${appliance.brand} manual says${best.section ? ` under "${best.section}"` : ""}.`;
        steps = row ? splitSteps(row.action) : splitSteps(best.text).slice(0, 5);
      } else {
        answer = `I don't have a manual for the ${appliance.name} yet, so I can only offer general guidance. You can ask me to ingest the manual from a URL.`;
        steps = ["Power the appliance off for one minute and back on.", "Check the model's support page for the exact code.", "Add the manual to HomeKeeper so I can look it up next time."];
      }
    }

    // If the answer points at a consumable we track, offer a reorder.
    const q = `${question} ${answer} ${steps.join(" ")}`.toLowerCase();
    const suggest = appliance.consumables.find((c) => {
      const words = c.name.toLowerCase().split(/\s+/);
      const mentioned = words.every((w) => q.includes(w)) || (c.partHint && q.includes(c.partHint.toLowerCase()));
      return mentioned && /\b(replace|replacing|replacement|swap|clogged|overdue|expired|new filter|descal\w*)\b/.test(q);
    });

    return {
      appliance,
      answer,
      steps,
      sources,
      manual,
      grounded,
      suggestReorder: suggest ? { consumableId: suggest.id, name: suggest.name } : undefined
    };
  }

  // -------------------------------------------------------------- maintenance

  async dueItems(householdId: string, withinDays = 30, applianceId?: string): Promise<DueItem[]> {
    const [tasks, appliances] = await Promise.all([this.store.listTasks(householdId, applianceId), this.store.listAppliances(householdId)]);
    const byId = new Map(appliances.map((a) => [a.id, a]));
    const today = isoDate(this.now());
    const items: DueItem[] = [];
    for (const t of tasks) {
      const a = byId.get(t.applianceId);
      if (!a) continue;
      const days = Math.round((new Date(t.nextDue).getTime() - new Date(today).getTime()) / DAY);
      if (days > withinDays) continue;
      items.push({ task: t, appliance: a, daysUntilDue: days, status: days < 0 ? "overdue" : days <= 7 ? "due_soon" : "upcoming" });
    }
    return items.sort((x, y) => x.daysUntilDue - y.daysUntilDue);
  }

  async logMaintenance(householdId: string, appliance: Appliance, taskRef: string, notes?: string, doneAt?: string): Promise<{ log: MaintenanceLog; task?: MaintenanceTask }> {
    const tasks = await this.store.listTasks(householdId, appliance.id);
    const r = taskRef.toLowerCase();
    const task = tasks.find((t) => t.id === taskRef) ?? tasks.find((t) => t.title.toLowerCase().includes(r) || r.includes(t.title.toLowerCase().split(" ").pop() ?? "\u0000"));
    const when = doneAt ?? this.now().toISOString();
    const log: MaintenanceLog = {
      id: randomUUID().slice(0, 8),
      householdId,
      applianceId: appliance.id,
      taskId: task?.id,
      title: task?.title ?? taskRef,
      doneAt: when,
      notes
    };
    await this.store.addLog(log);
    if (task) {
      task.lastDone = when.slice(0, 10);
      task.nextDue = addDays(when, task.intervalDays);
      await this.store.putTask(task);
      if (task.consumableId) {
        const c = appliance.consumables.find((x) => x.id === task.consumableId);
        if (c) {
          c.lastReplaced = when.slice(0, 10);
          appliance.updatedAt = this.now().toISOString();
          await this.store.putAppliance(appliance);
        }
      }
    }
    return { log, task };
  }

  async history(householdId: string, applianceId?: string) {
    return this.store.listLogs(householdId, applianceId);
  }

  // ------------------------------------------------------------------- orders

  quoteConsumable(appliance: Appliance, consumableRef?: string): { consumable: Consumable; product: ReturnType<typeof findProduct> } | { candidates: Consumable[] } {
    const list = appliance.consumables;
    if (list.length === 0) return { candidates: [] };
    let chosen: Consumable | undefined;
    if (consumableRef) {
      const r = consumableRef.toLowerCase();
      chosen = list.find((c) => c.id === consumableRef) ?? list.find((c) => c.name.toLowerCase().includes(r) || r.includes(c.name.toLowerCase()));
    }
    if (!chosen && list.length === 1) chosen = list[0];
    if (!chosen) return { candidates: list };
    return { consumable: chosen, product: findProduct(chosen.productQuery, chosen.partHint) };
  }

  async placeOrder(householdId: string, appliance: Appliance, consumable: Consumable, quantity = 1): Promise<Order> {
    const product = findProduct(consumable.productQuery, consumable.partHint);
    const order: Order = {
      id: `HK-${randomUUID().slice(0, 6).toUpperCase()}`,
      householdId,
      applianceId: appliance.id,
      consumableId: consumable.id,
      product,
      quantity,
      status: "placed",
      createdAt: this.now().toISOString()
    };
    await this.store.putOrder(order);
    return order;
  }

  async orders(householdId: string) {
    return this.store.listOrders(householdId);
  }

  // ----------------------------------------------------------------- warranty

  warranty(appliance: Appliance): { covered: boolean | "unknown"; expiresOn?: string; daysLeft?: number; months: number } {
    const months = appliance.warrantyMonths ?? CATALOG[appliance.category].defaultWarrantyMonths;
    if (!appliance.purchaseDate) return { covered: "unknown", months };
    const exp = new Date(appliance.purchaseDate);
    exp.setMonth(exp.getMonth() + months);
    const daysLeft = Math.round((exp.getTime() - this.now().getTime()) / DAY);
    return { covered: daysLeft >= 0, expiresOn: isoDate(exp), daysLeft, months };
  }
}

// ------------------------------------------------------------------ helpers

function extractTableRow(text: string, question: string): { code: string; meaning: string; action: string } | undefined {
  const codes = question.match(/\b[a-z]{1,2}\s?-?\d{1,3}\b|\b\d{1,2}\s?[ec]\b/gi) ?? [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 3) continue;
    for (const code of codes) {
      const norm = code.replace(/\s|-/g, "").toLowerCase();
      if (cells[0].replace(/\s|-/g, "").toLowerCase().includes(norm)) {
        return { code: cells[0], meaning: cells[1], action: cells[2] };
      }
    }
  }
  return undefined;
}

function splitSteps(text: string): string[] {
  return text
    .replace(/\|/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^\d+\.\s*|^-\s*/, "").trim())
    .filter((s) => s.length > 3);
}
