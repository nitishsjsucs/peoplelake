// PeopleLake Worker entry point. Routes are added as the build progresses (see PROGRESS.md).
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/health") {
      return Response.json({ ok: true, version: "0.1.0", environment: env.ENVIRONMENT, lake_mode: env.LAKE_MODE });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
