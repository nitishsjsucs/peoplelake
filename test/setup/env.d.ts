// Test-only bindings injected by vitest.config.ts.
declare namespace Cloudflare {
  interface Env {
    TEST_ACCESS_PRIVATE_JWK: string;
  }
}
