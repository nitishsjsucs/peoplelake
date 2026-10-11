INSERT INTO peoplelake_raw_sink
SELECT event_id, source, event_type, entity_id, source_sequence, source_updated_at, effective_date,
       schema_version, payload, payload_sha256, received_at, delivery_id, ingest_request_id, producer
FROM peoplelake_raw_stream;
