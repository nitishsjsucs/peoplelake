// Builds the dashboard (web/) into web/dist, which the Worker serves as static assets
// (wrangler.jsonc "assets"; /v1, /api, /internal and /dev run the Worker first). There is no Vite
// dev server in this repo: locally the dashboard is served by `wrangler dev` on 127.0.0.1:8791.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
