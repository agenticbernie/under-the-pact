import { Hono } from "hono"
import { cors } from "hono/cors"
import { Effect } from "effect"
import { PactConfigLive, PactConfigService } from "./config.js"

/**
 * Hono skeleton (BER-129).
 * Thin handlers only — deterministic policy + Solana tx live in later issues.
 * Sprint Gate: this file must NOT import/build/sign/submit transactions.
 * Neon Functions serves `export default app` (fetch handler).
 */

export const createApp = () => {
  const app = new Hono()

  // FE origins: local Astro + Cloudflare Pages preview/prod (wired via env later)
  app.use(
    "/*",
    cors({
      origin: (origin) => origin,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"]
    })
  )

  app.get("/api/health", async (c) => {
    const program = Effect.gen(function*() {
      const cfg = yield* PactConfigService
      return {
        ok: true,
        service: "pact-api",
        network: cfg.solanaNetwork,
        merchantId: cfg.merchant.merchantId,
        // Health never requires DB — BER-129 works before Neon branch exists
        db: cfg.databaseUrl ? "configured" : "not-configured"
      }
    })
    const result = await Effect.runPromise(
      program.pipe(Effect.provide(PactConfigLive))
    )
    return c.json(result)
  })

  // BER-132 stub: proves FE→BE wiring for the NL request. Always 501 until parser lands.
  app.post("/api/intent/parse", async (c) => {
    return c.json(
      {
        ok: false,
        code: "PARSER_ERROR",
        message: "Intent parser not implemented (BER-132). Skeleton only."
      },
      501
    )
  })

  app.get("/", (c) =>
    c.json({ ok: true, service: "pact-api", hint: "GET /api/health" })
  )

  return app
}

const app = createApp()
export default app
