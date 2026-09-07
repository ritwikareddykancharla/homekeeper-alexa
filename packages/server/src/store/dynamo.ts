import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  BatchWriteCommand
} from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { HouseholdStore } from "./types.js";
import type {
  Appliance,
  MaintenanceLog,
  MaintenanceTask,
  Manual,
  ManualChunk,
  Order
} from "../types.js";

/**
 * Single-table DynamoDB store.
 *
 *   PK = HH#<householdId>
 *   SK = APPLIANCE#<id> | TASK#<id> | LOG#<doneAt>#<id> | MANUAL#<id> | ORDER#<id>
 *
 * Manual chunks (with embeddings) can exceed the 400 KB item limit, so they
 * live in S3 at manuals/<householdId>/<manualId>.json.
 */
export class DynamoStore implements HouseholdStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly s3: S3Client;

  constructor(
    private readonly tableName: string,
    private readonly bucketName: string,
    region?: string
  ) {
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true }
    });
    this.s3 = new S3Client({ region });
  }

  private pk(householdId: string) {
    return `HH#${householdId}`;
  }

  private async query<T>(householdId: string, skPrefix: string): Promise<T[]> {
    const items: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: { ":pk": this.pk(householdId), ":sk": skPrefix },
          ExclusiveStartKey
        })
      );
      for (const it of res.Items ?? []) {
        const { PK: _pk, SK: _sk, ...rest } = it as Record<string, unknown>;
        items.push(rest as T);
      }
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  private async put(householdId: string, sk: string, item: object) {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: { PK: this.pk(householdId), SK: sk, ...item } })
    );
  }

  private async get<T>(householdId: string, sk: string): Promise<T | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { PK: this.pk(householdId), SK: sk } })
    );
    if (!res.Item) return undefined;
    const { PK: _pk, SK: _sk, ...rest } = res.Item;
    return rest as T;
  }

  async listAppliances(householdId: string) {
    const items = await this.query<Appliance>(householdId, "APPLIANCE#");
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }
  getAppliance(householdId: string, id: string) {
    return this.get<Appliance>(householdId, `APPLIANCE#${id}`);
  }
  putAppliance(a: Appliance) {
    return this.put(a.householdId, `APPLIANCE#${a.id}`, a);
  }
  async deleteAppliance(householdId: string, id: string) {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { PK: this.pk(householdId), SK: `APPLIANCE#${id}` } })
    );
  }

  async listTasks(householdId: string, applianceId?: string) {
    const items = await this.query<MaintenanceTask>(householdId, "TASK#");
    return items.filter((t) => !applianceId || t.applianceId === applianceId).sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  }
  putTask(t: MaintenanceTask) {
    return this.put(t.householdId, `TASK#${t.id}`, t);
  }
  async deleteTasksForAppliance(householdId: string, applianceId: string) {
    const tasks = (await this.listTasks(householdId, applianceId)).map((t) => ({
      DeleteRequest: { Key: { PK: this.pk(householdId), SK: `TASK#${t.id}` } }
    }));
    for (let i = 0; i < tasks.length; i += 25) {
      await this.doc.send(new BatchWriteCommand({ RequestItems: { [this.tableName]: tasks.slice(i, i + 25) } }));
    }
  }
  addLog(l: MaintenanceLog) {
    return this.put(l.householdId, `LOG#${l.doneAt}#${l.id}`, l);
  }
  async listLogs(householdId: string, applianceId?: string) {
    const items = await this.query<MaintenanceLog>(householdId, "LOG#");
    return items.filter((l) => !applianceId || l.applianceId === applianceId).sort((a, b) => b.doneAt.localeCompare(a.doneAt));
  }

  private chunkKey(householdId: string, manualId: string) {
    return `manuals/${householdId}/${manualId}.json`;
  }
  async putManual(manual: Manual, chunks: ManualChunk[]) {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: this.chunkKey(manual.householdId, manual.id),
        Body: JSON.stringify(chunks),
        ContentType: "application/json"
      })
    );
    await this.put(manual.householdId, `MANUAL#${manual.id}`, manual);
  }
  getManual(householdId: string, id: string) {
    return this.get<Manual>(householdId, `MANUAL#${id}`);
  }
  async getManualChunks(householdId: string, id: string) {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: this.chunkKey(householdId, id) })
      );
      const body = await res.Body?.transformToString();
      return body ? (JSON.parse(body) as ManualChunk[]) : [];
    } catch {
      return [];
    }
  }
  listManuals(householdId: string) {
    return this.query<Manual>(householdId, "MANUAL#");
  }

  putOrder(o: Order) {
    return this.put(o.householdId, `ORDER#${o.id}`, o);
  }
  async listOrders(householdId: string) {
    const items = await this.query<Order>(householdId, "ORDER#");
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
