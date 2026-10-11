// Where accepted deliveries go. Production: Basin Pipelines stream (exactly-once from stream to sink,
// Iceberg table in Basin Catalog on R2). Local: SinkRoller Durable Object, a labeled stand-in (ADR 0003).
import type { Pipeline } from "cloudflare:pipelines";
import type { RawRecord } from "../../shared/contracts.ts";
import type { AppConfig } from "../config.ts";
import type { SinkRoller } from "./sink-roller.ts";

export interface LakeSink {
  readonly kind: "basin" | "local-stand-in";
  send(records: RawRecord[]): Promise<void>;
}

export class BasinStreamSink implements LakeSink {
  readonly kind = "basin" as const;
  readonly #stream: Pipeline;
  constructor(stream: Pipeline) {
    this.#stream = stream;
  }
  async send(records: RawRecord[]): Promise<void> {
    await this.#stream.send(records as unknown as Record<string, unknown>[]);
  }
}

export const SINK_ROLLER_NAME = "local-sink";

export class LocalRollingSink implements LakeSink {
  readonly kind = "local-stand-in" as const;
  readonly #roller: DurableObjectStub<SinkRoller>;
  constructor(ns: DurableObjectNamespace<SinkRoller>) {
    this.#roller = ns.get(ns.idFromName(SINK_ROLLER_NAME));
  }
  async send(records: RawRecord[]): Promise<void> {
    await this.#roller.append(records);
  }
}

export function selectSink(config: AppConfig, env: Env): LakeSink {
  if (config.lakeMode === "basin") return new BasinStreamSink(env.RAW_STREAM);
  return new LocalRollingSink(env.SINK_ROLLER);
}
