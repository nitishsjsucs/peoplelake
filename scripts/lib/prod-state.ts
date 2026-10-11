// Shape of .prod/state.json, written by `npm run setup:prod` (never committed; mode 600).
export interface ProdState {
  account_id: string;
  workers_subdomain: string;
  access: { team_domain: string; aud: string; app_id?: string };
  role_map: { emails: Record<string, string[]>; service_tokens: Record<string, string> };
  catalog: { uri: string; warehouse: string; prefix: string };
  stream_id: string;
  gcp_project: string;
  runs_enabled: boolean;
  gcp_bootstrap_passed: boolean;
}

export const PLACEHOLDERS = [
  "__PL_RUNS_ENABLED__",
  "__PL_ACCESS_TEAM_DOMAIN__",
  "__PL_ACCESS_AUD__",
  "__PL_ACCESS_ROLE_MAP__",
  "__PL_GCP_PROJECT__",
  "__PL_CATALOG_URI__",
  "__PL_CATALOG_PREFIX__",
  "__PL_STREAM_ID__",
] as const;

export function placeholderValues(state: ProdState): Record<(typeof PLACEHOLDERS)[number], string> {
  return {
    __PL_RUNS_ENABLED__: state.runs_enabled ? "true" : "false",
    __PL_ACCESS_TEAM_DOMAIN__: state.access.team_domain,
    __PL_ACCESS_AUD__: state.access.aud,
    __PL_ACCESS_ROLE_MAP__: JSON.stringify(state.role_map),
    __PL_GCP_PROJECT__: state.gcp_project,
    __PL_CATALOG_URI__: state.catalog.uri,
    __PL_CATALOG_PREFIX__: state.catalog.prefix,
    __PL_STREAM_ID__: state.stream_id,
  };
}
