import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { exportJWK, generateKeyPair } from "jose";
import { defineConfig } from "vitest/config";
import { WORKER_TEST_VARS } from "./test/setup/worker-vars.ts";

// Ephemeral RS256 keys per test run: the Worker verifies with DEV_ACCESS_JWKS, tests sign with the private JWK.
async function ephemeralAccessKeys(): Promise<{ jwks: string; privateJwk: string }> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const kid = "vitest";
  const pub = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  const priv = { ...(await exportJWK(privateKey)), kid, alg: "RS256" };
  return { jwks: JSON.stringify({ keys: [pub] }), privateJwk: JSON.stringify(priv) };
}

export default defineConfig(async () => {
  const keys = await ephemeralAccessKeys();
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  ...WORKER_TEST_VARS,
                  DEV_ACCESS_JWKS: keys.jwks,
                  TEST_ACCESS_PRIVATE_JWK: keys.privateJwk,
                },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/worker/**/*.test.ts"],
            fileParallelism: false,
            testTimeout: 60_000,
          },
        },
        {
          test: { name: "node", include: ["test/node/**/*.test.ts"], environment: "node" },
        },
      ],
    },
  };
});
