import { Hono } from "hono"
import { cors } from "hono/cors"
import { Config, Effect, Layer, Schema } from "effect"
import {
  normalizeRequestText,
  PaymentRequest,
  PolicyErrorCode
} from "@pact/shared"
import { PactConfigLive, PactConfigService } from "./config.js"
import { LlmClient, LlmLive } from "./intent/llm.js"
import {
  merchantAliasesFor,
  parsePaymentIntent,
  type ParserContext
} from "./intent/parser.js"

/**
 * Hono skeleton (BER-129).
 * Thin handlers only — deterministic policy + Solana tx live in later issues.
 * Sprint Gate: this file must NOT import/build/sign/submit transactions.
 * Neon Functions serves `export default app` (fetch handler).
 */

export interface AppOptions {
  /** Override the LLM boundary in tests — production uses LlmLive. */
  llmLayer?: Layer.Layer<LlmClient>
}

export const createApp = (opts: AppOptions = {}) => {
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

  // BER-132: validate shape (400) -> LLM parse -> 200 Parsed |
  // 422 Clarification (recoverable, REQ-F-003) | 500 ParserError.
  // Parser failures use PARSER_ERROR; policy rejections (BER-134/135) use
  // their own codes — the two are always distinguishable.
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
    const shaped = Schema.decodeUnknownEither(PaymentRequest)(candidate)
    if (shaped._tag === "Left") {
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
    const program = Effect.gen(function* () {
      const cfg = yield* PactConfigService
      const baseUrl = yield* Config.string("LLM_BASE_URL").pipe(
        Config.withDefault("https://api.openai.com/v1")
      )
      const model = yield* Config.string("LLM_MODEL").pipe(
        Config.withDefault("gpt-4o-mini")
      )
      const apiKey = yield* Config.string("LLM_API_KEY").pipe(
        Config.withDefault("")
      )
      const ttlSeconds = yield* Config.number("INTENT_TTL_SECONDS").pipe(
        Config.withDefault(900)
      )
      const ctx: ParserContext = {
        network: cfg.solanaNetwork,
        tokenMint: cfg.usdcMint,
        recipientWallet: cfg.merchant.recipientWallet,
        merchantId: cfg.merchant.merchantId,
        merchantDisplayName: cfg.merchant.displayName,
        merchantAliases: merchantAliasesFor(
          cfg.merchant.displayName,
          cfg.merchant.merchantId
        ),
        ttlSeconds,
        llm: { baseUrl, apiKey, model }
      }
      const result = yield* parsePaymentIntent(shaped.right.text, ctx).pipe(
        Effect.catchAll((e) =>
          Effect.succeed({ _tag: "ParserFailed", message: e.message } as const)
        )
      )
      if (result._tag === "Parsed") {
        return { status: 200, body: { ok: true, intent: result.intent } } as const
      }
      if (result._tag === "Clarification") {
        return {
          status: 422,
          body: {
            ok: false,
            code: PolicyErrorCode.AMBIGUOUS_REQUEST,
            message: result.message,
            missing: result.missing
          }
        } as const
      }
      return {
        status: 500,
        body: {
          ok: false,
          code: PolicyErrorCode.PARSER_ERROR,
          message: result.message
        }
      } as const
    })
    const out = await Effect.runPromise(
      program.pipe(
        Effect.provide(PactConfigLive),
        Effect.provide(opts.llmLayer ?? LlmLive)
      )
    )
    if (out.status === 200) {
      return c.json(out.body, 200)
    }
    if (out.status === 422) {
      return c.json(out.body, 422)
    }
    return c.json(out.body, 500)
  })

  app.get("/", (c) =>
    c.json({ ok: true, service: "pact-api", hint: "GET /api/health" })
  )

  return app
}

const app = createApp()
export default app
