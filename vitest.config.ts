import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
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
});
