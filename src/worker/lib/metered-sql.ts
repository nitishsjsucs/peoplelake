// Every Durable Object SQL call goes through MeteredSql (SPEC 29.4.3): it drains the cursor and adds
// SqlStorageCursor.rowsRead and rowsWritten to in-memory counters for the current UTC day, so tests can
// pin how many rows an operation reads and writes against the Workers Free allowances (5 million rows
// read and 100,000 rows written a day per account), and operators can see the totals. Alarms count too:
// each setAlarm() is billed as one row written.

export interface SqlUsage {
  /** UTC day the counters belong to (YYYY-MM-DD). */
  day: string;
  rows_read: number;
  rows_written: number;
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class MeteredSql {
  readonly #sql: SqlStorage;
  readonly #now: () => number;
  #usage: SqlUsage;

  constructor(sql: SqlStorage, now: () => number = Date.now) {
    this.#sql = sql;
    this.#now = now;
    this.#usage = { day: utcDay(now()), rows_read: 0, rows_written: 0 };
  }

  #count(read: number, written: number): void {
    const day = utcDay(this.#now());
    if (day !== this.#usage.day) this.#usage = { day, rows_read: 0, rows_written: 0 };
    this.#usage.rows_read += read;
    this.#usage.rows_written += written;
  }

  /** Run a statement and return every row (the cursor is always drained, so its counters are final). */
  all<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    const cursor = this.#sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    this.#count(cursor.rowsRead, cursor.rowsWritten);
    return rows;
  }

  first<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T | null {
    return this.all<T>(query, ...bindings)[0] ?? null;
  }

  run(query: string, ...bindings: unknown[]): void {
    this.all(query, ...bindings);
  }

  /** Cloudflare bills each `setAlarm()` as one row written; callers count every alarm they set here. */
  countAlarmSet(): void {
    this.#count(0, 1);
  }

  /** Counters of the current UTC day (a copy). */
  usage(): SqlUsage {
    this.#count(0, 0);
    return { ...this.#usage };
  }

  /** Restore counters persisted earlier the same day (after an eviction); other days are ignored. */
  restore(saved: SqlUsage | null): void {
    if (saved === null) return;
    this.#count(0, 0);
    if (saved.day !== this.#usage.day) return;
    this.#usage.rows_read += saved.rows_read;
    this.#usage.rows_written += saved.rows_written;
  }
}
