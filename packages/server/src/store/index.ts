import { MemoryStore } from "./memory.js";
import { DynamoStore } from "./dynamo.js";
import type { HouseholdStore } from "./types.js";

export type { HouseholdStore } from "./types.js";
export { MemoryStore, DynamoStore };

/**
 * Pick a store from the environment:
 *   TABLE_NAME + MANUALS_BUCKET  -> DynamoDB + S3 (production)
 *   otherwise                    -> in-memory with JSON persistence at DATA_FILE
 */
export async function createStoreFromEnv(): Promise<HouseholdStore> {
  const table = process.env.TABLE_NAME;
  const bucket = process.env.MANUALS_BUCKET;
  if (table && bucket) {
    return new DynamoStore(table, bucket, process.env.AWS_REGION);
  }
  const file = process.env.DATA_FILE ?? ".data/homekeeper.json";
  return MemoryStore.open(file === "none" ? undefined : file);
}
