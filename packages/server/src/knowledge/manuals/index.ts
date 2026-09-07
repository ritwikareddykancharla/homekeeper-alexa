import { BOSCH_DISHWASHER } from "./bosch-dishwasher.js";
import { SAMSUNG_REFRIGERATOR } from "./samsung-refrigerator.js";
import { KEURIG_COFFEE } from "./keurig-coffee.js";
import { LG_WASHER } from "./lg-washer.js";

export interface BundledManual {
  key: string;
  title: string;
  brand: string;
  model: string;
  category: string;
  /** Regex matched against "brand model" to auto-attach on register_appliance. */
  match: RegExp;
  text: string;
}

/**
 * Sample manuals bundled with HomeKeeper so the demo works with zero setup.
 * These are original summaries written for this project in the style of an
 * owner's manual; they are not copies of manufacturer documents.
 */
export const BUNDLED_MANUALS: BundledManual[] = [
  {
    key: "bosch-300-dishwasher",
    title: "Bosch 300 Series Dishwasher Owner's Guide (summary)",
    brand: "Bosch",
    model: "SHEM63W55N",
    category: "dishwasher",
    match: /bosch.*(dishwasher|she|shp|shx|shv|300|500|800)/i,
    text: BOSCH_DISHWASHER
  },
  {
    key: "samsung-rf28-refrigerator",
    title: "Samsung French Door Refrigerator RF28 Owner's Guide (summary)",
    brand: "Samsung",
    model: "RF28R7351SG",
    category: "refrigerator",
    match: /samsung.*(fridge|refrigerator|rf\d|rs\d|rt\d)/i,
    text: SAMSUNG_REFRIGERATOR
  },
  {
    key: "keurig-k-elite",
    title: "Keurig K-Elite Brewer Use & Care (summary)",
    brand: "Keurig",
    model: "K-Elite",
    category: "coffee_maker",
    match: /keurig/i,
    text: KEURIG_COFFEE
  },
  {
    key: "lg-front-load-washer",
    title: "LG Front Load Washer WM4000 Owner's Guide (summary)",
    brand: "LG",
    model: "WM4000HWA",
    category: "washer",
    match: /lg.*(washer|washing|wm\d)/i,
    text: LG_WASHER
  }
];

export function findBundledManual(brand: string, model: string, category?: string): BundledManual | undefined {
  const hay = `${brand} ${model} ${category ?? ""}`;
  return BUNDLED_MANUALS.find((m) => m.match.test(hay));
}
