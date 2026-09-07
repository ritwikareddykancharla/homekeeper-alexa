import type { Product } from "../types.js";

/**
 * Product lookup used by reorder_consumable.
 *
 * In production this would call the Amazon Product Advertising API or the
 * Alexa+ purchasing capability. For the hackathon it is a deterministic mock
 * that returns a plausible product for a query, so the purchasing flow is
 * fully demoable without live commerce credentials.
 */
const KNOWN: Array<{ match: RegExp; product: Omit<Product, "url"> }> = [
  {
    match: /refrigerator water filter|fridge filter|DA29|water filter/i,
    product: {
      id: "B07HXNJ7WX",
      title: "Refrigerator Water Filter Replacement, NSF 42 Certified (2 pack)",
      price: 34.99,
      currency: "USD",
      deliveryEstimate: "Tomorrow by 10 PM",
      imageHint: "cylindrical white filter"
    }
  },
  {
    match: /hvac|furnace|merv/i,
    product: {
      id: "B01BTRYPJ8",
      title: "Pleated HVAC Air Filter, MERV 11, 16x25x1 (4 pack)",
      price: 42.5,
      currency: "USD",
      deliveryEstimate: "2 days",
      imageHint: "white pleated filter"
    }
  },
  {
    match: /descal/i,
    product: {
      id: "B00DF6N6SO",
      title: "Descaling Solution for Coffee and Espresso Machines (2 uses)",
      price: 9.95,
      currency: "USD",
      deliveryEstimate: "Tomorrow",
      imageHint: "blue bottle"
    }
  },
  {
    match: /dishwasher cleaner/i,
    product: {
      id: "B00BAJ2TKC",
      title: "Dishwasher Cleaner Tablets, Fresh Scent (6 count)",
      price: 7.49,
      currency: "USD",
      deliveryEstimate: "Tomorrow",
      imageHint: "tablet box"
    }
  },
  {
    match: /washing machine cleaner|washer cleaner/i,
    product: {
      id: "B00Q3JXJQG",
      title: "Washing Machine Cleaner Tablets (6 count)",
      price: 8.99,
      currency: "USD",
      deliveryEstimate: "Tomorrow",
      imageHint: "tablet box"
    }
  },
  {
    match: /hepa/i,
    product: {
      id: "B07R8Y1QHL",
      title: "True HEPA Replacement Filter with Activated Carbon Pre-filter",
      price: 29.99,
      currency: "USD",
      deliveryEstimate: "2 days",
      imageHint: "rectangular filter"
    }
  },
  {
    match: /robot vacuum.*filter|vacuum filter/i,
    product: {
      id: "B08L3JZK5V",
      title: "Robot Vacuum Replacement Filters (6 pack)",
      price: 12.99,
      currency: "USD",
      deliveryEstimate: "Tomorrow",
      imageHint: "small filters"
    }
  },
  {
    match: /brush set/i,
    product: {
      id: "B07WGT8XJK",
      title: "Robot Vacuum Replacement Brush Kit (roller + side brushes)",
      price: 18.99,
      currency: "USD",
      deliveryEstimate: "2 days",
      imageHint: "brush kit"
    }
  },
  {
    match: /charcoal filter|coffee.*water filter/i,
    product: {
      id: "B01N7NCK5U",
      title: "Charcoal Water Filter Cartridges, Universal (6 pack)",
      price: 11.49,
      currency: "USD",
      deliveryEstimate: "Tomorrow",
      imageHint: "small cartridges"
    }
  },
  {
    match: /dryer vent/i,
    product: {
      id: "B01N0B6BSI",
      title: "Dryer Vent Cleaner Kit, 30 ft flexible brush",
      price: 24.99,
      currency: "USD",
      deliveryEstimate: "2 days",
      imageHint: "brush kit"
    }
  },
  {
    match: /9v|batter/i,
    product: {
      id: "B00MNV8E0C",
      title: "9V Alkaline Batteries (4 pack)",
      price: 10.99,
      currency: "USD",
      deliveryEstimate: "Tomorrow",
      imageHint: "battery pack"
    }
  },
  {
    match: /under sink|cartridge/i,
    product: {
      id: "B07D8Q9V5Z",
      title: "Under Sink Water Filter Replacement Cartridge",
      price: 39.99,
      currency: "USD",
      deliveryEstimate: "2 days",
      imageHint: "cartridge"
    }
  }
];

export function findProduct(query: string, partHint?: string): Product {
  const q = partHint ? `${partHint} ${query}` : query;
  const hit = KNOWN.find((k) => k.match.test(q));
  const base: Omit<Product, "url"> = hit?.product ?? {
    id: "B0GENERIC01",
    title: `${query.replace(/\b\w/g, (c) => c.toUpperCase())}`,
    price: 19.99,
    currency: "USD",
    deliveryEstimate: "3 days",
    imageHint: "product"
  };
  const title = partHint && !base.title.includes(partHint) ? `${base.title} (fits ${partHint})` : base.title;
  return {
    ...base,
    title,
    url: `https://www.amazon.com/s?k=${encodeURIComponent(q)}`
  };
}
