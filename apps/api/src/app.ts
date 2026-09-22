import { Hono } from "hono"
import { cors } from "hono/cors"
import { Effect, Schema } from "effect"
import {
  normalizeRequestText,
  PaymentRequest,
  PolicyErrorCode
} from "@pact/shared"
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

  // BER-130: accept the NL request, reject empty/invalid shape with 400.
  // Valid text reaches the parser layer — which lands in BER-132, so a
  // well-formed request still answers 501 until then (proves handoff).
  app.post("/api/intent/parse", async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        {
          ok: false,
          code: PolicyErrorCode.INVALID_REQUEST,
          message: "Request body must be JSON with a 'text' field."
        },
        400
      )
    }
    const raw = body as { text?: unknown }
    const candidate = {
      text:
        typeof raw.text === "string" ? normalizeRequestText(raw.text) : raw.text
    }
    const parsed = Schema.decodeUnknownEither(PaymentRequest)(candidate)
    if (parsed._tag === "Left") {
      return c.json(
        {
          ok: false,
          code: PolicyErrorCode.INVALID_REQUEST,
          message:
            "Payment request must be 1-2000 non-blank characters in 'text'."
        },
        400
      )
    }
    return c.json(
      {
        ok: false,
        code: PolicyErrorCode.PARSER_ERROR,
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
