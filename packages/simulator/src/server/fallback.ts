/**
 * Rule-based intent router used when Bedrock is unavailable (no credentials,
 * model access not enabled, outage). It is deliberately simple: pick a tool,
 * pull an appliance reference out of the utterance, and phrase the result.
 * The real host (host.ts) uses Bedrock Converse; this keeps the demo alive.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface Routed {
  tool: string;
  args: Record<string, unknown>;
}

const APPLIANCE_WORDS = [
  "dishwasher", "fridge", "refrigerator", "freezer", "washer", "washing machine", "dryer", "oven", "range", "stove",
  "microwave", "coffee maker", "coffee machine", "keurig", "furnace", "hvac", "ac", "air conditioner", "water heater",
  "boiler", "thermostat", "vacuum", "roomba", "garbage disposal", "disposal", "toaster", "kettle", "tv"
];

function applianceIn(text: string): string | undefined {
  const t = text.toLowerCase();
  const found = APPLIANCE_WORDS.filter((w) => new RegExp(`\\b${w}\\b`).test(t)).sort((a, b) => b.length - a.length)[0];
  return found;
}

export function route(text: string, lastTool?: string): Routed | undefined {
  const t = text.toLowerCase().trim();
  const appliance = applianceIn(t);

  if (/^(yes|yeah|yep|sure|go ahead|do it|confirm|order it|please do)\b/.test(t) && lastTool === "reorder_consumable") {
    return { tool: "reorder_consumable", args: { __confirmLast: true } };
  }
  if (/\b(what|which|list|show).*(appliances?|devices?|own|have)\b/.test(t) || /\bmy appliances\b/.test(t)) {
    return { tool: "list_appliances", args: {} };
  }
  if (/\b(warranty|covered|guarantee)\b/.test(t)) {
    return { tool: "warranty_status", args: { appliance: appliance ?? text } };
  }
  if (/\b(order|reorder|buy|need a new|out of)\b/.test(t)) {
    const consumable = t.match(/\b(water filter|filter|cleaner|descal\w*|descaling solution|pods?|detergent|bulb|belt|hose|battery|batteries)\b/)?.[1] ?? "filter";
    return { tool: "reorder_consumable", args: appliance ? { appliance, consumable } : { appliance: consumable } };
  }
  if (/\b(due|attention|maintenance|upcoming|overdue|schedule|this month|this week)\b/.test(t)) {
    return { tool: "maintenance_due", args: { withinDays: /week/.test(t) ? 7 : 30 } };
  }
  if (/\b(i (just )?(cleaned|replaced|descaled|changed|did)|done|finished)\b/.test(t) && appliance) {
    const task = t.match(/\b(cleaned|replaced|descaled|changed) (the )?([a-z ]+?)(\.|$| on| in| for)/)?.[3] ?? "maintenance";
    return { tool: "log_maintenance", args: { appliance, task } };
  }
  if (/\b(add|register|new|got a|bought)\b/.test(t) && appliance) {
    const brandModel = text.match(/\b([A-Z][a-zA-Z]+)\s+([A-Z0-9][A-Z0-9-]{3,})\b/);
    return { tool: "register_appliance", args: { brand: brandModel?.[1] ?? "Unknown", model: brandModel?.[2] ?? "unknown", name: appliance } };
  }
  if (appliance || /\b(error|code|e\d{1,3}|showing|blinking|leak|won't|doesn't|isn't|not working|noise|smell|half)\b/.test(t)) {
    return { tool: "troubleshoot", args: { appliance: appliance ?? text, question: text } };
  }
  return undefined;
}

/**
 * Spoken sentence for a tool result when there is no model to phrase it. Every
 * HomeKeeper tool already returns a voice-ready sentence as its first text block.
 */
export function phrase(result: CallToolResult): string {
  const txt = result.content.find((c) => c.type === "text") as { text: string } | undefined;
  return txt?.text ?? (result.isError ? "That didn't work." : "Done. Details are on screen.");
}

export const CANT_HELP = "I can help with your appliances: what you own, error codes, maintenance that's due, warranties, and reordering parts. What would you like?";
