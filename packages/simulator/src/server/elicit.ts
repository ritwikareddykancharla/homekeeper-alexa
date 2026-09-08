import { randomUUID } from "node:crypto";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { HostEvent } from "./host.js";

/** Elicitation requests waiting on a browser answer (answered via POST /api/elicit). */
export const pendingElicits = new Map<string, (r: ElicitResult) => void>();

/**
 * Build an elicitation handler that forwards the server's question to the
 * browser over `send` and resolves when the user answers (or after 2 minutes).
 */
export function elicitVia(send: (ev: HostEvent) => void) {
  return (params: ElicitRequest["params"]): Promise<ElicitResult> => {
    const id = randomUUID();
    send({ type: "elicit", id, message: params.message, schema: (params as { requestedSchema?: unknown }).requestedSchema });
    return new Promise<ElicitResult>((resolve) => {
      pendingElicits.set(id, resolve);
      setTimeout(() => {
        if (pendingElicits.delete(id)) resolve({ action: "cancel" });
      }, 120_000);
    });
  };
}
