# R2 event notification for lake commits (optimization only)

Rule on bucket `peoplelake-lake`: `object-create` events whose key ends with `.metadata.json` go to the Queue `peoplelake-lake-events`, which the Worker consumes (`src/worker/lake/lake-events.ts`) to request a warehouse run sooner.

```bash
npx wrangler r2 bucket notification create peoplelake-lake \
  --event-type object-create --queue peoplelake-lake-events \
  --suffix .metadata.json --description "peoplelake iceberg commits"
```

Why it is only an optimization: whether R2 notifications fire for objects written by Basin itself is not verified. The primary production trigger is the per-minute cron that polls the Basin Catalog table metadata (Iceberg REST `loadTable`) for new append snapshots. `npm run doctor` reports both signals: the last catalog snapshot seen and the last R2 notification received.

Locally there is no R2 notification: the `SinkRoller` Durable Object enqueues a message with the same fields (`account`, `action`, `bucket`, `object.key`, `object.size`, `object.eTag`, `eventTime`) after every roll, and that is the primary local trigger.
