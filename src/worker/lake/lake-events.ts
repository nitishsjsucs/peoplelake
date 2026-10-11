// Queue consumer for R2-notification-shaped lake events (SPEC 7.5). Production: object-create on an
// Iceberg `.metadata.json` (an optimization; the catalog poll is the primary trigger). Local: every
// SinkRoller roll file under `local-sink/` (the primary local trigger). Malformed messages are acked and
// counted; a Coordinator failure retries the batch (max 5, then the dead-letter queue).
import { coordinatorStub } from "../orchestration/coordinator.ts";

export function isLakeCommitKey(key: string): boolean {
  return key.endsWith(".metadata.json") || key.startsWith("local-sink/");
}

export async function handleLakeEvents(batch: MessageBatch<unknown>, env: Env): Promise<{ relevant: number; malformed: number; ignored: number }> {
  const relevant: Message<unknown>[] = [];
  let malformed = 0;
  let ignored = 0;
  let latest = "";
  for (const msg of batch.messages) {
    const body = msg.body as { object?: { key?: unknown }; eventTime?: unknown } | null;
    const key = body?.object?.key;
    if (typeof key !== "string") {
      malformed++;
      msg.ack();
      continue;
    }
    if (!isLakeCommitKey(key)) {
      ignored++;
      msg.ack();
      continue;
    }
    const at = typeof body?.eventTime === "string" ? body.eventTime : new Date().toISOString();
    if (at > latest) latest = at;
    relevant.push(msg);
  }
  const coordinator = coordinatorStub(env);
  try {
    if (malformed > 0) await coordinator.countMalformedLakeEvents(malformed);
    if (relevant.length > 0) {
      await coordinator.markNewData(latest);
      await coordinator.requestRun("lake-event");
    }
    for (const msg of relevant) msg.ack();
  } catch (err) {
    console.error(`peoplelake lake events: ${err instanceof Error ? err.message : String(err)}`);
    for (const msg of relevant) msg.retry();
  }
  return { relevant: relevant.length, malformed, ignored };
}
