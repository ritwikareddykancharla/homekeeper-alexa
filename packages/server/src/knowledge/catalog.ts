import type { ApplianceCategory } from "../types.js";

export interface CatalogTask {
  title: string;
  intervalDays: number;
  instructions: string;
  /** If set, this task consumes a part that can be reordered. */
  consumable?: { name: string; productQuery: string };
}

export interface CatalogEntry {
  label: string;
  keywords: string[];
  defaultWarrantyMonths: number;
  tasks: CatalogTask[];
}

/**
 * Baseline maintenance knowledge by appliance category. Bedrock refines this
 * with brand/model specifics (part numbers, intervals) when available; without
 * Bedrock this catalog alone still produces a sensible schedule.
 */
export const CATALOG: Record<ApplianceCategory, CatalogEntry> = {
  dishwasher: {
    label: "Dishwasher",
    keywords: ["dishwasher", "dish washer"],
    defaultWarrantyMonths: 12,
    tasks: [
      {
        title: "Clean the filter",
        intervalDays: 30,
        instructions: "Remove the lower rack, twist out the cylindrical filter, rinse under warm water, scrub with a soft brush, and reinstall until it clicks."
      },
      {
        title: "Run a cleaning cycle",
        intervalDays: 90,
        instructions: "Run an empty hot cycle with a dishwasher cleaner or a cup of white vinegar on the top rack.",
        consumable: { name: "Dishwasher cleaner", productQuery: "dishwasher cleaner tablets" }
      },
      {
        title: "Check and wipe door gasket",
        intervalDays: 90,
        instructions: "Wipe the rubber seal around the door with a damp cloth to prevent leaks and odors."
      },
      {
        title: "Inspect spray arms",
        intervalDays: 180,
        instructions: "Remove spray arms and clear any clogged holes with a toothpick."
      }
    ]
  },
  refrigerator: {
    label: "Refrigerator",
    keywords: ["fridge", "refrigerator", "freezer"],
    defaultWarrantyMonths: 12,
    tasks: [
      {
        title: "Replace water filter",
        intervalDays: 180,
        instructions: "Locate the filter (usually inside the fresh food compartment or base grille), twist to release, insert the new filter, and run 2 to 3 gallons of water through the dispenser.",
        consumable: { name: "Water filter", productQuery: "refrigerator water filter" }
      },
      {
        title: "Clean condenser coils",
        intervalDays: 180,
        instructions: "Unplug the unit, remove the base grille, and vacuum the coils with a brush attachment."
      },
      {
        title: "Wipe door seals",
        intervalDays: 90,
        instructions: "Clean the gaskets with mild soap; check for gaps by closing the door on a piece of paper."
      },
      {
        title: "Replace air filter",
        intervalDays: 180,
        instructions: "Swap the interior air freshness filter if your model has one.",
        consumable: { name: "Air filter", productQuery: "refrigerator air filter" }
      }
    ]
  },
  washer: {
    label: "Washing machine",
    keywords: ["washer", "washing machine", "laundry"],
    defaultWarrantyMonths: 12,
    tasks: [
      {
        title: "Run tub clean cycle",
        intervalDays: 30,
        instructions: "Run the Tub Clean or Self Clean cycle with a washer cleaner tablet.",
        consumable: { name: "Washer cleaner", productQuery: "washing machine cleaner tablets" }
      },
      {
        title: "Clean drain pump filter",
        intervalDays: 90,
        instructions: "Open the lower access panel, place a towel, unscrew the filter, remove lint and debris, and reinstall."
      },
      {
        title: "Wipe door gasket",
        intervalDays: 30,
        instructions: "Pull back the rubber boot and wipe out moisture and residue to prevent mildew."
      },
      {
        title: "Inspect hoses",
        intervalDays: 365,
        instructions: "Check inlet hoses for bulges or cracks; replace every 5 years."
      }
    ]
  },
  dryer: {
    label: "Dryer",
    keywords: ["dryer", "tumble dryer"],
    defaultWarrantyMonths: 12,
    tasks: [
      { title: "Clean lint screen", intervalDays: 7, instructions: "Remove and clear the lint screen before or after every load." },
      {
        title: "Clean dryer vent duct",
        intervalDays: 365,
        instructions: "Disconnect the duct and clear lint with a vent brush kit; check the exterior vent flap.",
        consumable: { name: "Dryer vent cleaning kit", productQuery: "dryer vent cleaning brush kit" }
      },
      { title: "Wash lint screen with soap", intervalDays: 90, instructions: "Scrub with warm soapy water to remove fabric softener film; let dry fully." }
    ]
  },
  hvac: {
    label: "HVAC / furnace",
    keywords: ["hvac", "furnace", "air conditioner", "ac", "heat pump", "thermostat"],
    defaultWarrantyMonths: 60,
    tasks: [
      {
        title: "Replace air filter",
        intervalDays: 90,
        instructions: "Slide out the old filter, note the size printed on the frame, and insert the new one with the airflow arrow pointing toward the unit.",
        consumable: { name: "HVAC air filter", productQuery: "HVAC furnace air filter MERV 11" }
      },
      { title: "Professional tune-up", intervalDays: 365, instructions: "Schedule a seasonal inspection before heating or cooling season." },
      { title: "Clear outdoor condenser", intervalDays: 180, instructions: "Remove leaves and debris; keep 2 feet of clearance around the unit." }
    ]
  },
  water_heater: {
    label: "Water heater",
    keywords: ["water heater", "boiler", "hot water"],
    defaultWarrantyMonths: 72,
    tasks: [
      { title: "Flush the tank", intervalDays: 365, instructions: "Turn off power and water, connect a hose to the drain valve, and drain several gallons to remove sediment." },
      { title: "Test pressure relief valve", intervalDays: 365, instructions: "Lift the lever briefly; water should discharge and stop cleanly." },
      { title: "Inspect anode rod", intervalDays: 1095, instructions: "Remove and check for corrosion; replace if more than half eaten away." }
    ]
  },
  range_oven: {
    label: "Range / oven",
    keywords: ["oven", "range", "stove", "cooktop"],
    defaultWarrantyMonths: 12,
    tasks: [
      { title: "Deep clean oven interior", intervalDays: 90, instructions: "Use the self-clean cycle or an oven cleaner; remove racks first." },
      { title: "Check door seal", intervalDays: 180, instructions: "Inspect the gasket for tears; a bad seal wastes energy and causes uneven baking." }
    ]
  },
  microwave: {
    label: "Microwave",
    keywords: ["microwave"],
    defaultWarrantyMonths: 12,
    tasks: [
      {
        title: "Replace charcoal filter",
        intervalDays: 180,
        instructions: "For over-the-range models, remove the vent grille and swap the charcoal filter.",
        consumable: { name: "Charcoal filter", productQuery: "over the range microwave charcoal filter" }
      },
      { title: "Clean grease filter", intervalDays: 30, instructions: "Slide out the mesh filter under the unit and wash in hot soapy water." }
    ]
  },
  coffee_maker: {
    label: "Coffee maker",
    keywords: ["coffee", "espresso", "keurig", "nespresso"],
    defaultWarrantyMonths: 12,
    tasks: [
      {
        title: "Descale",
        intervalDays: 90,
        instructions: "Run the descaling program with a descaling solution, then flush with two reservoirs of fresh water.",
        consumable: { name: "Descaling solution", productQuery: "coffee machine descaling solution" }
      },
      {
        title: "Replace water filter",
        intervalDays: 60,
        instructions: "Swap the charcoal filter cartridge in the reservoir.",
        consumable: { name: "Water filter cartridge", productQuery: "coffee maker charcoal water filter" }
      }
    ]
  },
  water_filter: {
    label: "Water filtration",
    keywords: ["water filter", "reverse osmosis", "under sink filter", "pitcher"],
    defaultWarrantyMonths: 12,
    tasks: [
      {
        title: "Replace filter cartridge",
        intervalDays: 180,
        instructions: "Shut off the supply valve, twist off the old cartridge, install the new one, and flush for 5 minutes.",
        consumable: { name: "Filter cartridge", productQuery: "under sink water filter replacement cartridge" }
      }
    ]
  },
  robot_vacuum: {
    label: "Robot vacuum",
    keywords: ["roomba", "robot vacuum", "robovac"],
    defaultWarrantyMonths: 12,
    tasks: [
      {
        title: "Replace filter",
        intervalDays: 60,
        instructions: "Open the bin, pull out the filter, and insert a new one.",
        consumable: { name: "Vacuum filter", productQuery: "robot vacuum replacement filter" }
      },
      { title: "Clean brushes and sensors", intervalDays: 14, instructions: "Remove hair from the roller brushes; wipe cliff sensors with a dry cloth." },
      {
        title: "Replace brushes",
        intervalDays: 180,
        instructions: "Swap the main roller and side brushes.",
        consumable: { name: "Brush set", productQuery: "robot vacuum replacement brush set" }
      }
    ]
  },
  air_purifier: {
    label: "Air purifier",
    keywords: ["air purifier", "purifier", "hepa"],
    defaultWarrantyMonths: 12,
    tasks: [
      {
        title: "Replace HEPA filter",
        intervalDays: 240,
        instructions: "Open the back panel, remove the old filter, and insert the new one with the arrows facing the unit.",
        consumable: { name: "HEPA filter", productQuery: "air purifier HEPA replacement filter" }
      },
      { title: "Vacuum pre-filter", intervalDays: 30, instructions: "Vacuum dust from the mesh pre-filter." }
    ]
  },
  garbage_disposal: {
    label: "Garbage disposal",
    keywords: ["disposal", "garbage disposal", "insinkerator"],
    defaultWarrantyMonths: 24,
    tasks: [
      { title: "Freshen and degrease", intervalDays: 30, instructions: "Grind ice cubes with a little baking soda, then flush with cold water." }
    ]
  },
  smoke_detector: {
    label: "Smoke / CO detector",
    keywords: ["smoke detector", "smoke alarm", "co detector", "carbon monoxide"],
    defaultWarrantyMonths: 120,
    tasks: [
      { title: "Test alarm", intervalDays: 30, instructions: "Press and hold the test button until the alarm sounds." },
      {
        title: "Replace batteries",
        intervalDays: 365,
        instructions: "Replace with fresh batteries even if the unit is hardwired (backup).",
        consumable: { name: "9V batteries", productQuery: "9V alkaline batteries 4 pack" }
      },
      { title: "Replace unit", intervalDays: 3650, instructions: "Detectors expire 10 years after the manufacture date printed on the back." }
    ]
  },
  other: {
    label: "Appliance",
    keywords: [],
    defaultWarrantyMonths: 12,
    tasks: [{ title: "Annual check", intervalDays: 365, instructions: "Inspect for wear, clean, and review the manual's maintenance section." }]
  }
};

export const CATEGORIES = Object.keys(CATALOG) as ApplianceCategory[];

/** Best-effort category detection from free text like "Bosch dishwasher" or "Keurig K-Elite". */
export function detectCategory(text: string): ApplianceCategory {
  const t = text.toLowerCase();
  let best: { cat: ApplianceCategory; len: number } | undefined;
  for (const cat of CATEGORIES) {
    for (const kw of CATALOG[cat].keywords) {
      if (t.includes(kw) && (!best || kw.length > best.len)) best = { cat, len: kw.length };
    }
  }
  return best?.cat ?? "other";
}
