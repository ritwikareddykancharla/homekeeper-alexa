export type ApplianceCategory =
  | "dishwasher"
  | "refrigerator"
  | "washer"
  | "dryer"
  | "hvac"
  | "water_heater"
  | "range_oven"
  | "microwave"
  | "coffee_maker"
  | "water_filter"
  | "robot_vacuum"
  | "air_purifier"
  | "garbage_disposal"
  | "smoke_detector"
  | "other";

export interface Consumable {
  id: string;
  name: string; // "Water filter"
  partHint?: string; // "DA29-00020B"
  intervalDays: number;
  lastReplaced?: string; // ISO date
  productQuery: string; // what to search for when reordering
}

export interface Appliance {
  id: string;
  householdId: string;
  name: string; // "Kitchen dishwasher"
  brand: string;
  model: string;
  category: ApplianceCategory;
  room?: string;
  purchaseDate?: string; // ISO date
  warrantyMonths?: number;
  serial?: string;
  manualId?: string;
  consumables: Consumable[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MaintenanceTask {
  id: string;
  householdId: string;
  applianceId: string;
  title: string; // "Replace water filter"
  intervalDays: number;
  instructions?: string;
  consumableId?: string;
  lastDone?: string; // ISO date
  nextDue: string; // ISO date
  source: "catalog" | "ai" | "user";
}

export interface MaintenanceLog {
  id: string;
  householdId: string;
  applianceId: string;
  taskId?: string;
  title: string;
  doneAt: string; // ISO datetime
  notes?: string;
}

export interface ManualChunk {
  id: string;
  text: string;
  section?: string;
  page?: number;
  embedding?: number[];
}

export interface Manual {
  id: string;
  householdId: string;
  applianceId: string;
  title: string;
  source: string; // URL, "upload", or "bundled:<name>"
  chunkCount: number;
  ingestedAt: string;
}

export interface Order {
  id: string;
  householdId: string;
  applianceId: string;
  consumableId?: string;
  product: Product;
  quantity: number;
  status: "quoted" | "placed";
  createdAt: string;
}

export interface Product {
  id: string; // ASIN-like
  title: string;
  price: number;
  currency: "USD";
  url: string;
  imageHint?: string;
  deliveryEstimate: string;
}

export interface HouseholdSnapshot {
  appliances: Appliance[];
  tasks: MaintenanceTask[];
  logs: MaintenanceLog[];
  manuals: Manual[];
  orders: Order[];
}
