// Production new-data trigger (SPEC 7.6): Iceberg REST loadTable against Basin Catalog every minute. An
// APPEND snapshot with a sequence number above the committed watermark's means new data; compaction
// (replace) snapshots never trigger a run. Snapshot ids are 64-bit, so they are read as strings.
export interface IcebergSnapshot {
  snapshot_id: string;
  sequence_number: number;
  operation: string;
  timestamp_ms: number;
}

export interface CatalogPoll {
  ok: boolean;
  polled_at: string;
  current_snapshot: string | null;
  newest_append: string | null;
  newest_append_sequence: number | null;
  watermark: string | null;
  new_data: boolean;
  error?: string;
}

export function loadTableUrl(catalogUri: string, prefix: string): string {
  return `${catalogUri.replace(/\/$/, "")}/v1/${prefix}/namespaces/peoplelake/tables/raw_events`;
}

/** JSON.parse that keeps Iceberg snapshot ids (64-bit integers) exact by quoting them first. */
export function parseTableMetadata(text: string): { currentSnapshotId: string | null; snapshots: IcebergSnapshot[] } {
  const quoted = text.replace(/"(snapshot-id|parent-snapshot-id|current-snapshot-id)"\s*:\s*(-?\d+)/g, '"$1":"$2"');
  const body = JSON.parse(quoted) as { metadata?: Record<string, unknown> };
  const meta = (body.metadata ?? body) as Record<string, unknown>;
  const snaps = (meta["snapshots"] ?? []) as Record<string, unknown>[];
  const current = meta["current-snapshot-id"];
  return {
    currentSnapshotId: typeof current === "string" && current !== "-1" ? current : null,
    snapshots: snaps.map((s) => ({
      snapshot_id: String(s["snapshot-id"]),
      sequence_number: Number(s["sequence-number"] ?? 0),
      operation: String((s["summary"] as Record<string, unknown> | undefined)?.["operation"] ?? ""),
      timestamp_ms: Number(s["timestamp-ms"] ?? 0),
    })),
  };
}

export function hasNewAppend(snapshots: IcebergSnapshot[], watermark: string | null): { newest: IcebergSnapshot | null; newData: boolean } {
  const appends = snapshots.filter((s) => s.operation === "append").sort((a, b) => a.sequence_number - b.sequence_number);
  const newest = appends[appends.length - 1] ?? null;
  if (newest === null) return { newest: null, newData: false };
  if (watermark === null) return { newest, newData: true };
  const mark = snapshots.find((s) => s.snapshot_id === watermark);
  if (!mark) return { newest, newData: true }; // the watermark snapshot expired: the reader falls back to a full scan
  return { newest, newData: appends.some((s) => s.sequence_number > mark.sequence_number) };
}

export async function pollCatalog(opts: {
  catalogUri: string;
  prefix: string;
  token: string;
  watermark: string | null;
  fetch?: typeof fetch;
  now?: Date;
}): Promise<CatalogPoll> {
  const polledAt = (opts.now ?? new Date()).toISOString();
  try {
    const res = await (opts.fetch ?? fetch)(loadTableUrl(opts.catalogUri, opts.prefix), {
      headers: { authorization: `Bearer ${opts.token}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`loadTable HTTP ${res.status}`);
    const meta = parseTableMetadata(await res.text());
    const { newest, newData } = hasNewAppend(meta.snapshots, opts.watermark);
    return {
      ok: true,
      polled_at: polledAt,
      current_snapshot: meta.currentSnapshotId,
      newest_append: newest?.snapshot_id ?? null,
      newest_append_sequence: newest?.sequence_number ?? null,
      watermark: opts.watermark,
      new_data: newData,
    };
  } catch (err) {
    return {
      ok: false,
      polled_at: polledAt,
      current_snapshot: null,
      newest_append: null,
      newest_append_sequence: null,
      watermark: opts.watermark,
      new_data: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
