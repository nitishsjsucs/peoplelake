// Queue consumer for lake events (SPEC 29.4.1): the LandingRoller sends one message per roll, in both
// environments, with the key under landing/raw_events/. Each batch marks new data and requests one run;
// messages are only triggers (the cron backstop covers a lost one). Other keys are acked and ignored,
// malformed messages are acked and counted, and a Coordinator failure retries the batch (then the DLQ).
import { coordinatorStub } from "../orchestration/coordinator.ts";
import { LANDING_PREFIX } from "./landing-keys.ts";

export function isLakeEventKey(key: string): boolean {
  return key.startsWith(LANDING_PREFIX) && key.endsWith(".ndjson");
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
    if (!isLakeEventKey(key)) {
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
