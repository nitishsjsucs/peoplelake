// Startup prewarm (SPEC 29.4.2). zod builds its parsers lazily on first use and V8 compiles the ingest
// functions on first call; without a prewarm that cost lands in an isolate's first request, against the
// Workers Free plan's 10 ms of CPU per request. Running the whole ingest path once at module scope (one
// valid envelope of every event type through the three batch schemas, normalization, RawRecord and
// NDJSON) moves it into the 1 s startup budget. The envelopes are the contract fixtures (synthetic), which
// cover all 18 event types.
import atsFixture from "../../../contracts/fixtures/source-ats.valid.json";
import hrisFixture from "../../../contracts/fixtures/source-hris.valid.json";
import rawRecordFixture from "../../../contracts/fixtures/raw-record.valid.json";
import talentFixture from "../../../contracts/fixtures/source-talent.valid.json";
import { prewarmConfig } from "../config.ts";
import { type PrewarmReport, prewarmSchemas } from "./prewarm-core.ts";

/** Runs once when the module is first imported (isolate startup), before any request is handled. */
prewarmConfig(); // the role map parser parseConfig uses on every request
export const PREWARMED: PrewarmReport = prewarmSchemas({ hris: hrisFixture, ats: atsFixture, talent: talentFixture, rawRecord: rawRecordFixture });
