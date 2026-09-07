import type {
  Appliance,
  MaintenanceLog,
  MaintenanceTask,
  Manual,
  ManualChunk,
  Order
} from "../types.js";

/**
 * Persistence boundary for HomeKeeper. Everything is scoped to a household so
 * one deployment can serve many Alexa+ accounts.
 */
export interface HouseholdStore {
  // Appliances
  listAppliances(householdId: string): Promise<Appliance[]>;
  getAppliance(householdId: string, id: string): Promise<Appliance | undefined>;
  putAppliance(appliance: Appliance): Promise<void>;
  deleteAppliance(householdId: string, id: string): Promise<void>;

  // Maintenance
  listTasks(householdId: string, applianceId?: string): Promise<MaintenanceTask[]>;
  putTask(task: MaintenanceTask): Promise<void>;
  deleteTasksForAppliance(householdId: string, applianceId: string): Promise<void>;
  addLog(log: MaintenanceLog): Promise<void>;
  listLogs(householdId: string, applianceId?: string): Promise<MaintenanceLog[]>;

  // Manuals (metadata in the store, chunks possibly elsewhere)
  putManual(manual: Manual, chunks: ManualChunk[]): Promise<void>;
  getManual(householdId: string, id: string): Promise<Manual | undefined>;
  getManualChunks(householdId: string, id: string): Promise<ManualChunk[]>;
  listManuals(householdId: string): Promise<Manual[]>;

  // Orders
  putOrder(order: Order): Promise<void>;
  listOrders(householdId: string): Promise<Order[]>;
}
