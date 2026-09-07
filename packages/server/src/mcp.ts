import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import type { HomeKeeperService } from "./service.js";
import { CATEGORIES, CATALOG } from "./knowledge/catalog.js";
import { VIEW_NAMES, viewUri, type ViewName } from "./views.js";
import type { Appliance } from "./types.js";

export const SERVER_INFO = { name: "homekeeper", version: "0.1.0" } as const;

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface McpServerDeps {
  service: HomeKeeperService;
  views: Record<ViewName, string>;
  defaultHouseholdId?: string;
}

/**
 * Resolve which household a request belongs to.
 *
 * Alexa+ identifies the customer through account linking (OAuth). We accept, in
 * order: an `x-household-id` header (used by the simulator and MCP Inspector),
 * the OAuth subject when the request was authenticated, then a default.
 */
export function householdIdFrom(extra: Extra, fallback = "demo-home"): string {
  const h = extra.requestInfo?.headers?.["x-household-id"];
  const fromHeader = Array.isArray(h) ? h[0] : h;
  if (fromHeader) return String(fromHeader);
  const sub = (extra.authInfo?.extra as { sub?: string } | undefined)?.sub;
  if (sub) return sub;
  return fallback;
}

const text = (t: string): CallToolResult["content"][number] => ({ type: "text", text: t });

function ok(spoken: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [text(spoken)], structuredContent: structured };
}

function fail(message: string, structured: Record<string, unknown> = {}): CallToolResult {
  return { content: [text(message)], structuredContent: { error: message, ...structured }, isError: true };
}

const applianceSummary = (a: Appliance) => ({
  id: a.id,
  name: a.name,
  brand: a.brand,
  model: a.model,
  category: a.category,
  categoryLabel: CATALOG[a.category].label,
  room: a.room,
  purchaseDate: a.purchaseDate,
  warrantyMonths: a.warrantyMonths,
  hasManual: Boolean(a.manualId),
  consumables: a.consumables.map((c) => ({ id: c.id, name: c.name, partHint: c.partHint, intervalDays: c.intervalDays, lastReplaced: c.lastReplaced }))
});

/**
 * Build the HomeKeeper MCP server. One instance per session (or per request in
 * stateless mode); all state lives in the service's store.
 */
export function createMcpServer({ service, views, defaultHouseholdId }: McpServerDeps): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { logging: {} },
    instructions:
      "HomeKeeper is the household's memory for appliances. Use list_appliances to see what the home owns, register_appliance when the user mentions a new device, " +
      "troubleshoot for error codes or 'why is X doing Y' questions (it reads the actual manual), maintenance_due for what needs attention, log_maintenance when the user says they did something, " +
      "and reorder_consumable when a filter or part needs replacing. When an appliance reference is ambiguous the tools return candidates; ask the user which one they mean."
  });

  const hh = (extra: Extra) => householdIdFrom(extra, defaultHouseholdId);

  /** Resolve an appliance reference or return a tool result asking for disambiguation. */
  async function pick(extra: Extra, ref: string): Promise<{ appliance: Appliance } | { result: CallToolResult }> {
    const householdId = hh(extra);
    const matches = await service.resolveAppliance(householdId, ref);
    if (matches.length === 1) return { appliance: matches[0] };
    if (matches.length === 0) {
      const all = await service.listAppliances(householdId);
      if (all.length === 0) return { result: fail("There are no appliances registered yet. Ask the user for the brand and model and call register_appliance.") };
      return {
        result: fail(`I couldn't find an appliance matching "${ref}". Registered appliances: ${all.map((a) => a.name).join(", ")}.`, {
          candidates: all.map(applianceSummary)
        })
      };
    }
    return {
      result: ok(`Which one do you mean: ${matches.map((a) => `${a.name} (${a.brand} ${a.model})`).join(" or ")}?`, {
        needsDisambiguation: true,
        candidates: matches.map(applianceSummary)
      })
    };
  }

  // ------------------------------------------------------------------ resources (MCP App views)

  for (const name of VIEW_NAMES) {
    registerAppResource(
      server,
      `HomeKeeper ${name} view`,
      viewUri(name),
      { description: `Interactive ${name} card rendered by the host.`, _meta: { ui: { prefersBorder: true } } },
      async () => ({
        contents: [{ uri: viewUri(name), mimeType: RESOURCE_MIME_TYPE, text: views[name] }]
      })
    );
  }

  // ------------------------------------------------------------------ tools

  server.registerTool(
    "register_appliance",
    {
      title: "Register appliance",
      description:
        "Add an appliance to the household and derive its maintenance schedule. Provide brand and model at minimum; the category is detected automatically. " +
        "If a manual for the model is known, it is attached so troubleshooting is grounded.",
      inputSchema: {
        brand: z.string().describe("Manufacturer, e.g. Bosch"),
        model: z.string().describe("Model name or number, e.g. SHEM63W55N or 'K-Elite'"),
        name: z.string().optional().describe("Friendly name, e.g. 'kitchen dishwasher'. Generated if omitted."),
        category: z.enum(CATEGORIES as [string, ...string[]]).optional().describe("Appliance category. Detected from brand/model/name when omitted."),
        room: z.string().optional(),
        purchaseDate: z.string().optional().describe("ISO date YYYY-MM-DD"),
        warrantyMonths: z.number().int().positive().optional(),
        serial: z.string().optional(),
        notes: z.string().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (args, extra) => {
      const { appliance, tasks, manual } = await service.registerAppliance(hh(extra), {
        ...args,
        category: args.category as Appliance["category"] | undefined
      });
      const spoken =
        `Registered the ${appliance.name} (${appliance.brand} ${appliance.model}). I set up ${tasks.length} maintenance tasks` +
        (appliance.consumables.length ? ` and I'm tracking ${appliance.consumables.map((c) => c.name.toLowerCase()).join(", ")}` : "") +
        (manual ? `. I also attached the ${manual.title}, so you can ask me about error codes.` : ". Send me the manual URL and I'll read it for troubleshooting.");
      return ok(spoken, {
        appliance: applianceSummary(appliance),
        tasks: tasks.map((t) => ({ id: t.id, title: t.title, intervalDays: t.intervalDays, nextDue: t.nextDue, source: t.source })),
        manual: manual ? { id: manual.id, title: manual.title, chunkCount: manual.chunkCount } : null
      });
    }
  );

  registerAppTool(
    server,
    "list_appliances",
    {
      title: "List appliances",
      description: "List every appliance in the household with room, model, manual status, and tracked consumables. Renders a carousel card.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: viewUri("appliances") } }
    },
    async (_args, extra) => {
      const householdId = hh(extra);
      const list = await service.listAppliances(householdId);
      const due = await service.dueItems(householdId, 30);
      const dueBy = new Map<string, number>();
      for (const d of due) dueBy.set(d.appliance.id, (dueBy.get(d.appliance.id) ?? 0) + 1);
      if (list.length === 0) return ok("No appliances are registered yet. Tell me a brand and model to get started.", { appliances: [] });
      const spoken = `You have ${list.length} appliance${list.length === 1 ? "" : "s"}: ${list.map((a) => a.name).join(", ")}.` + (due.length ? ` ${due.length} maintenance item${due.length === 1 ? "" : "s"} need attention in the next 30 days.` : "");
      return ok(spoken, {
        appliances: list.map((a) => ({ ...applianceSummary(a), dueCount: dueBy.get(a.id) ?? 0, warranty: service.warranty(a) }))
      });
    }
  );

  server.registerTool(
    "remove_appliance",
    {
      title: "Remove appliance",
      description: "Remove an appliance and its maintenance schedule from the household. Confirm with the user before calling.",
      inputSchema: { appliance: z.string().describe("Appliance id or a reference like 'the old fridge'") },
      annotations: { destructiveHint: true }
    },
    async ({ appliance }, extra) => {
      const p = await pick(extra, appliance);
      if ("result" in p) return p.result;
      await service.removeAppliance(hh(extra), p.appliance.id);
      return ok(`Removed the ${p.appliance.name}.`, { removed: applianceSummary(p.appliance) });
    }
  );

  server.registerTool(
    "ingest_manual",
    {
      title: "Ingest manual",
      description:
        "Attach an owner's manual to an appliance so troubleshooting answers are grounded in the real document. Provide a URL (PDF or web page) or raw text. " +
        "The manual is chunked, embedded with Amazon Bedrock, and stored for retrieval.",
      inputSchema: {
        appliance: z.string().describe("Appliance id or reference"),
        url: z.string().url().optional().describe("Public URL to the manual (PDF or HTML)"),
        text: z.string().min(200).optional().describe("Raw manual text, if you have it instead of a URL"),
        title: z.string().optional()
      },
      annotations: { openWorldHint: true }
    },
    async ({ appliance, url, text: raw, title }, extra) => {
      if (!url && !raw) return fail("Provide either a url or text for the manual.");
      const p = await pick(extra, appliance);
      if ("result" in p) return p.result;
      try {
        const manual = url
          ? await service.ingestManualFromUrl(hh(extra), p.appliance, url, title)
          : await service.ingestManualText(hh(extra), p.appliance, title ?? `${p.appliance.brand} ${p.appliance.model} manual`, "upload", raw!);
        return ok(`I read the manual for the ${p.appliance.name}: ${manual.chunkCount} sections indexed. Ask me about any error code or how-to.`, {
          manual: { id: manual.id, title: manual.title, chunkCount: manual.chunkCount, source: manual.source },
          appliance: applianceSummary(p.appliance)
        });
      } catch (err) {
        return fail(`I couldn't ingest that manual: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  registerAppTool(
    server,
    "troubleshoot",
    {
      title: "Troubleshoot",
      description:
        "Answer a problem or question about a specific appliance using its manual: error codes ('E24'), symptoms ('not draining'), or how-tos ('how do I descale'). " +
        "Returns a grounded answer with steps and the manual excerpt it came from. Renders a card with the source page.",
      inputSchema: {
        appliance: z.string().describe("Appliance id or reference, e.g. 'dishwasher'"),
        question: z.string().describe("The user's problem or question, verbatim")
      },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: viewUri("troubleshoot") } }
    },
    async ({ appliance, question }, extra) => {
      const p = await pick(extra, appliance);
      if ("result" in p) return p.result;
      const r = await service.troubleshoot(hh(extra), p.appliance, question);
      const spoken = r.answer + (r.steps.length ? ` Steps: ${r.steps.slice(0, 4).map((s, i) => `${i + 1}. ${s}`).join(" ")}` : "") + (r.suggestReorder ? ` Want me to reorder the ${r.suggestReorder.name.toLowerCase()}?` : "");
      return ok(spoken, {
        appliance: applianceSummary(p.appliance),
        question,
        answer: r.answer,
        steps: r.steps,
        grounded: r.grounded,
        manual: r.manual ? { id: r.manual.id, title: r.manual.title } : null,
        sources: r.sources.map((s) => ({ section: s.section, page: s.page, excerpt: s.text.slice(0, 600), score: Number(s.score.toFixed(3)) })),
        suggestReorder: r.suggestReorder ?? null
      });
    }
  );

  registerAppTool(
    server,
    "maintenance_due",
    {
      title: "Maintenance due",
      description: "What maintenance is overdue or coming up across the household (or for one appliance). Renders a timeline card.",
      inputSchema: {
        withinDays: z.number().int().min(0).max(365).default(30).describe("Look-ahead window in days"),
        appliance: z.string().optional().describe("Limit to one appliance (id or reference)")
      },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: viewUri("maintenance") } }
    },
    async ({ withinDays, appliance }, extra) => {
      let applianceId: string | undefined;
      if (appliance) {
        const p = await pick(extra, appliance);
        if ("result" in p) return p.result;
        applianceId = p.appliance.id;
      }
      const items = await service.dueItems(hh(extra), withinDays, applianceId);
      const overdue = items.filter((i) => i.status === "overdue");
      const soon = items.filter((i) => i.status === "due_soon");
      let spoken: string;
      if (items.length === 0) spoken = `Nothing is due in the next ${withinDays} days. The home is in good shape.`;
      else {
        const parts: string[] = [];
        if (overdue.length) parts.push(`${overdue.length} overdue: ${overdue.slice(0, 3).map((i) => `${i.task.title.toLowerCase()} on the ${i.appliance.name}`).join(", ")}`);
        if (soon.length) parts.push(`${soon.length} due this week: ${soon.slice(0, 3).map((i) => `${i.task.title.toLowerCase()} on the ${i.appliance.name}`).join(", ")}`);
        const rest = items.length - overdue.length - soon.length;
        if (rest > 0) parts.push(`${rest} more coming up`);
        spoken = parts.join(". ") + ".";
      }
      return ok(spoken, {
        withinDays,
        items: items.map((i) => ({
          taskId: i.task.id,
          title: i.task.title,
          instructions: i.task.instructions,
          nextDue: i.task.nextDue,
          lastDone: i.task.lastDone,
          daysUntilDue: i.daysUntilDue,
          status: i.status,
          consumableId: i.task.consumableId ?? null,
          appliance: { id: i.appliance.id, name: i.appliance.name, brand: i.appliance.brand, category: i.appliance.category }
        }))
      });
    }
  );

  server.registerTool(
    "log_maintenance",
    {
      title: "Log maintenance",
      description: "Record that a maintenance task was completed (e.g. 'I cleaned the dishwasher filter'). Resets that task's schedule and marks any consumable as replaced.",
      inputSchema: {
        appliance: z.string().describe("Appliance id or reference"),
        task: z.string().describe("Task id or a description like 'cleaned the filter'"),
        notes: z.string().optional(),
        doneAt: z.string().optional().describe("ISO datetime; defaults to now")
      }
    },
    async ({ appliance, task, notes, doneAt }, extra) => {
      const p = await pick(extra, appliance);
      if ("result" in p) return p.result;
      const { log, task: matched } = await service.logMaintenance(hh(extra), p.appliance, task, notes, doneAt);
      const spoken = matched
        ? `Logged "${matched.title}" for the ${p.appliance.name}. Next due ${matched.nextDue}.`
        : `Logged "${task}" for the ${p.appliance.name}. It didn't match a scheduled task, so I recorded it as a one-off.`;
      return ok(spoken, { log, task: matched ?? null });
    }
  );

  server.registerTool(
    "maintenance_history",
    {
      title: "Maintenance history",
      description: "What has been done to an appliance (or the whole home), most recent first.",
      inputSchema: { appliance: z.string().optional(), limit: z.number().int().min(1).max(50).default(10) },
      annotations: { readOnlyHint: true }
    },
    async ({ appliance, limit }, extra) => {
      let applianceId: string | undefined;
      if (appliance) {
        const p = await pick(extra, appliance);
        if ("result" in p) return p.result;
        applianceId = p.appliance.id;
      }
      const logs = (await service.history(hh(extra), applianceId)).slice(0, limit);
      if (logs.length === 0) return ok("No maintenance has been logged yet.", { logs: [] });
      return ok(`${logs.length} entr${logs.length === 1 ? "y" : "ies"}. Most recent: ${logs[0].title} on ${logs[0].doneAt.slice(0, 10)}.`, { logs });
    }
  );

  registerAppTool(
    server,
    "reorder_consumable",
    {
      title: "Reorder consumable",
      description:
        "Find and order a replacement part or consumable for an appliance (water filter, HEPA filter, descaler...). " +
        "Without confirm=true this returns a quote for the user to approve; with confirm=true it places the order. " +
        "If the host supports elicitation, the server asks the user to confirm directly. Renders an order card.",
      inputSchema: {
        appliance: z.string().describe("Appliance id or reference"),
        consumable: z.string().optional().describe("Which consumable (id or name). Optional if the appliance tracks only one."),
        quantity: z.number().int().min(1).max(10).default(1),
        confirm: z.boolean().default(false).describe("Set true only after the user has approved the quoted product and price")
      },
      annotations: { destructiveHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: viewUri("order") } }
    },
    async ({ appliance, consumable, quantity, confirm }, extra) => {
      const householdId = hh(extra);
      const p = await pick(extra, appliance);
      if ("result" in p) return p.result;
      const quote = service.quoteConsumable(p.appliance, consumable);
      if ("candidates" in quote) {
        if (quote.candidates.length === 0) return fail(`The ${p.appliance.name} has no consumables on record.`, { appliance: applianceSummary(p.appliance) });
        return ok(`Which part for the ${p.appliance.name}: ${quote.candidates.map((c) => c.name.toLowerCase()).join(" or ")}?`, {
          needsDisambiguation: true,
          appliance: applianceSummary(p.appliance),
          candidates: quote.candidates
        });
      }
      const { consumable: c, product } = quote;
      const total = (product.price * quantity).toFixed(2);

      let approved = confirm;
      let elicited = false;
      if (!approved && server.server.getClientCapabilities()?.elicitation) {
        elicited = true;
        try {
          const res = await server.server.elicitInput({
            mode: "form",
            message: `Order ${quantity} x ${product.title} for $${total} (${product.deliveryEstimate})?`,
            requestedSchema: {
              type: "object",
              properties: {
                confirm: { type: "boolean", title: "Place this order", default: true },
                quantity: { type: "integer", title: "Quantity", minimum: 1, maximum: 10, default: quantity }
              },
              required: ["confirm"]
            }
          });
          if (res.action === "accept" && res.content?.confirm === true) {
            approved = true;
            const q = Number(res.content.quantity);
            if (Number.isInteger(q) && q >= 1 && q <= 10) quantity = q;
          } else {
            return ok("Okay, I won't order it.", { status: "cancelled", appliance: applianceSummary(p.appliance), consumable: c, product, quantity });
          }
        } catch (err) {
          // Host advertised elicitation but failed; fall back to the two-step flow.
          console.warn("[reorder] elicitation failed:", err instanceof Error ? err.message : err);
          elicited = false;
        }
      }

      if (!approved) {
        return ok(`I found ${product.title} for $${product.price.toFixed(2)}, arriving ${product.deliveryEstimate.toLowerCase()}. Should I order ${quantity}?`, {
          status: "quoted",
          appliance: applianceSummary(p.appliance),
          consumable: c,
          product,
          quantity,
          total: Number(total)
        });
      }

      const order = await service.placeOrder(householdId, p.appliance, c, quantity);
      return ok(`Done. Order ${order.id}: ${quantity} x ${product.title}, $${(product.price * quantity).toFixed(2)}, arriving ${product.deliveryEstimate.toLowerCase()}. I'll remind you to swap it when it lands.`, {
        status: "placed",
        elicited,
        order,
        appliance: applianceSummary(p.appliance),
        consumable: c,
        product,
        quantity,
        total: Number((product.price * quantity).toFixed(2))
      });
    }
  );

  server.registerTool(
    "warranty_status",
    {
      title: "Warranty status",
      description: "Whether an appliance is still under warranty, when it expires, and what the user needs to make a claim.",
      inputSchema: { appliance: z.string().describe("Appliance id or reference") },
      annotations: { readOnlyHint: true }
    },
    async ({ appliance }, extra) => {
      const p = await pick(extra, appliance);
      if ("result" in p) return p.result;
      const w = service.warranty(p.appliance);
      let spoken: string;
      if (w.covered === "unknown") spoken = `I don't know when you bought the ${p.appliance.name}. The standard warranty is ${w.months} months; tell me the purchase date and I'll track it.`;
      else if (w.covered) spoken = `The ${p.appliance.name} is under warranty for ${w.daysLeft} more days, until ${w.expiresOn}. Keep the receipt and the serial number${p.appliance.serial ? ` (${p.appliance.serial})` : ""} handy for a claim.`;
      else spoken = `The ${p.appliance.name}'s ${w.months}-month warranty expired on ${w.expiresOn}.`;
      return ok(spoken, { appliance: applianceSummary(p.appliance), warranty: w });
    }
  );

  // ------------------------------------------------------------------ prompts

  server.registerPrompt(
    "weekly_home_checkup",
    {
      title: "Weekly home checkup",
      description: "Summarise what needs attention this week and offer to reorder anything running low."
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Run my weekly home checkup: call maintenance_due for the next 14 days, summarise overdue items first, and for any task that needs a consumable, offer to reorder it."
          }
        }
      ]
    })
  );

  return server;
}
