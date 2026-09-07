import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HouseholdStore } from "./types.js";
import type {
  Appliance,
  MaintenanceLog,
  MaintenanceTask,
  Manual,
  ManualChunk,
  Order
} from "../types.js";

interface HouseholdData {
  appliances: Record<string, Appliance>;
  tasks: Record<string, MaintenanceTask>;
  logs: MaintenanceLog[];
  manuals: Record<string, Manual>;
  chunks: Record<string, ManualChunk[]>;
  orders: Record<string, Order>;
}

const empty = (): HouseholdData => ({
  appliances: {},
  tasks: {},
  logs: [],
  manuals: {},
  chunks: {},
  orders: {}
});

/**
 * In-memory store with optional JSON file persistence. Used for local dev,
 * tests, and as a zero-dependency fallback when no DynamoDB table is set.
 */
export class MemoryStore implements HouseholdStore {
  private data = new Map<string, HouseholdData>();
  private flushTimer?: NodeJS.Timeout;

  constructor(private readonly filePath?: string) {}

  static async open(filePath?: string): Promise<MemoryStore> {
    const store = new MemoryStore(filePath);
    if (filePath) {
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, HouseholdData>;
        for (const [k, v] of Object.entries(parsed)) store.data.set(k, v);
      } catch {
        // fresh store
      }
    }
    return store;
  }

  private h(householdId: string): HouseholdData {
    let d = this.data.get(householdId);
    if (!d) {
      d = empty();
      this.data.set(householdId, d);
    }
    return d;
  }

  private scheduleFlush() {
    if (!this.filePath) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), 200);
  }

  async flush() {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(Object.fromEntries(this.data), null, 2));
  }

  async listAppliances(householdId: string) {
    return Object.values(this.h(householdId).appliances).sort((a, b) => a.name.localeCompare(b.name));
  }
  async getAppliance(householdId: string, id: string) {
    return this.h(householdId).appliances[id];
  }
  async putAppliance(appliance: Appliance) {
    this.h(appliance.householdId).appliances[appliance.id] = appliance;
    this.scheduleFlush();
  }
  async deleteAppliance(householdId: string, id: string) {
    delete this.h(householdId).appliances[id];
    this.scheduleFlush();
  }

  async listTasks(householdId: string, applianceId?: string) {
    return Object.values(this.h(householdId).tasks)
      .filter((t) => !applianceId || t.applianceId === applianceId)
      .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  }
  async putTask(task: MaintenanceTask) {
    this.h(task.householdId).tasks[task.id] = task;
    this.scheduleFlush();
  }
  async deleteTasksForAppliance(householdId: string, applianceId: string) {
    const d = this.h(householdId);
    for (const [id, t] of Object.entries(d.tasks)) if (t.applianceId === applianceId) delete d.tasks[id];
    this.scheduleFlush();
  }
  async addLog(log: MaintenanceLog) {
    this.h(log.householdId).logs.push(log);
    this.scheduleFlush();
  }
  async listLogs(householdId: string, applianceId?: string) {
    return this.h(householdId)
      .logs.filter((l) => !applianceId || l.applianceId === applianceId)
      .sort((a, b) => b.doneAt.localeCompare(a.doneAt));
  }

  async putManual(manual: Manual, chunks: ManualChunk[]) {
    const d = this.h(manual.householdId);
    d.manuals[manual.id] = manual;
    d.chunks[manual.id] = chunks;
    this.scheduleFlush();
  }
  async getManual(householdId: string, id: string) {
    return this.h(householdId).manuals[id];
  }
  async getManualChunks(householdId: string, id: string) {
    return this.h(householdId).chunks[id] ?? [];
  }
  async listManuals(householdId: string) {
    return Object.values(this.h(householdId).manuals);
  }

  async putOrder(order: Order) {
    this.h(order.householdId).orders[order.id] = order;
    this.scheduleFlush();
  }
  async listOrders(householdId: string) {
    return Object.values(this.h(householdId).orders).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
