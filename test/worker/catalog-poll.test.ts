import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { hasNewAppend, loadTableUrl, parseTableMetadata, pollCatalog } from "../../src/worker/lake/catalog-poll.ts";
import { coordinatorStub } from "../../src/worker/orchestration/coordinator.ts";
import { runScheduled } from "../../src/worker/orchestration/triggers.ts";

afterEach(async () => {
  await reset();
});

// Snapshot ids above 2^53 must survive parsing exactly.
const metadata = (extra = "") => `{
  "metadata-location": "s3://lake/metadata/00003.metadata.json",
  "metadata": {
    "current-snapshot-id": 9223372036854775001,
    "snapshots": [
      {"snapshot-id": 9223372036854775000, "sequence-number": 1, "timestamp-ms": 1, "summary": {"operation": "append"}},
      {"snapshot-id": 9223372036854775001, "sequence-number": 2, "timestamp-ms": 2, "summary": {"operation": "replace"}}${extra}
    ]
  }
}`;

describe("Basin Catalog poll", () => {
  it("reads snapshot ids exactly and builds the loadTable URL", () => {
    const meta = parseTableMetadata(metadata());
    expect(meta.currentSnapshotId).toBe("9223372036854775001");
    expect(meta.snapshots.map((s) => s.snapshot_id)).toEqual(["9223372036854775000", "9223372036854775001"]);
    expect(loadTableUrl("https://catalog.example/iceberg/", "abc_lake")).toBe(
      "https://catalog.example/iceberg/v1/abc_lake/namespaces/peoplelake/tables/raw_events",
    );
  });

  it("an append after the watermark means new data; a replace (compaction) does not", () => {
    const { snapshots } = parseTableMetadata(metadata());
    expect(hasNewAppend(snapshots, "9223372036854775000").newData).toBe(false);
    expect(hasNewAppend(snapshots, null).newData).toBe(true);
    const more = parseTableMetadata(
      metadata(`,\n{"snapshot-id": 9223372036854775002, "sequence-number": 3, "timestamp-ms": 3, "summary": {"operation": "append"}}`),
    );
    expect(hasNewAppend(more.snapshots, "9223372036854775000")).toMatchObject({ newData: true, newest: { snapshot_id: "9223372036854775002" } });
    expect(hasNewAppend(more.snapshots, "expired-snapshot").newData).toBe(true);
  });

  it("sends the bearer token and records errors instead of throwing", async () => {
    const seen: Request[] = [];
    const ok = await pollCatalog({
      catalogUri: "https://catalog.example/iceberg",
      prefix: "abc_lake",
      token: "r2-token",
      watermark: null,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Request(input, init));
        return new Response(metadata());
      }) as typeof fetch,
    });
    expect(ok).toMatchObject({ ok: true, new_data: true, newest_append: "9223372036854775000" });
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer r2-token");
    const bad = await pollCatalog({
      catalogUri: "https://catalog.example/iceberg",
      prefix: "abc_lake",
      token: "r2-token",
      watermark: null,
      fetch: (async () => new Response("denied", { status: 403 })) as typeof fetch,
    });
    expect(bad).toMatchObject({ ok: false, new_data: false, error: "loadTable HTTP 403" });
  });

  it("the scheduled handler polls in basin mode and requests a catalog run", async () => {
    await coordinatorStub(env).setTestOptions({ startWorkflows: false });
    const basinEnv = { ...env, LAKE_MODE: "basin", BASIN_CATALOG_URI: "https://catalog.example/iceberg", BASIN_CATALOG_PREFIX: "abc", R2_CATALOG_TOKEN: "t" };
    const out = await runScheduled(basinEnv as unknown as Env, Date.now(), (async () => new Response(metadata())) as typeof fetch);
    expect(out["poll"]).toMatchObject({ ok: true, new_data: true });
    const status = await coordinatorStub(env).status();
    expect(status["catalog_last_poll"]).toMatchObject({ ok: true });
    expect(status["active_run_id"]).not.toBeNull();
  });
});
