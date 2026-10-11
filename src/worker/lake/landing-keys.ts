// Landing roll keys (SPEC 29.4.1): landing/raw_events/g<generation>/r<roll_seq:010d>.ndjson. Zero-padded
// roll numbers make key order equal roll order, so the committer's cursor is a plain string compare.
export const LANDING_PREFIX = "landing/raw_events/";

export function landingPrefix(generation: number): string {
  return `${LANDING_PREFIX}g${generation}/`;
}

export function rollKey(generation: number, rollSeq: number): string {
  return `${landingPrefix(generation)}r${String(rollSeq).padStart(10, "0")}.ndjson`;
}
