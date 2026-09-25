import { Hono } from "hono"
import { cors } from "hono/cors"
import { Config, Effect, Layer, Schema } from "effect"
import {
  normalizeRequestText,
  PaymentIntent,
  PaymentRequest,
  PolicyErrorCode
} from "@pact/shared"
import { PactConfigLive, PactConfigService } from "./config.js"
import { LlmClient, LlmLive } from "./intent/llm.js"
import {
  MerchantRegistry,
  MerchantRegistryLive
} from "./merchant/registry.js"
import {
  merchantAliasesFor,
  parsePaymentIntent,
  type ParserContext
} from "./intent/parser.js"
import { sealIntent, verifyIntentSeal } from "./intent/seal.js"
import {
  decideConfirmation,
  type ConfirmationDecision
} from "./intent/confirm.js"
import {
  LifecycleStore,
  lifecycleStoreLayerFromEnv
} from "./policy/lifecycle.js"
import { checkPolicyForBuild, validateIntent } from "./policy/engine.js"
import { assertConfirmed } from "./intent/confirm.js"
import { buildUsdcTransfer, type SolanaReads } from "./solana/txbuilder.js"

/**
 * Hono skeleton (BER-129).
 * Thin handlers only — deterministic policy + Solana tx live in later issues.
 * Sprint Gate: this file must NOT import/build/sign/submit transactions.
 * Neon Functions serves `export default app` (fetch handler).
 */

export interface AppOptions {
  /** Override the LLM boundary in tests — production uses LlmLive. */
  llmLayer?: Layer.Layer<LlmClient>
  /** Override the lifecycle store in tests — one fresh store per app. */
  lifecycleLayer?: Layer.Layer<LifecycleStore>
  /** Override Solana reads in tests — production reads live RPC. */
  solanaReads?: SolanaReads
}

export const createApp = (opts: AppOptions = {}) => {
  const app = new Hono()
  // One store per app instance: isolated in tests, single copy per
  // process/isolate in production. LIFECYCLE_STORE selects the backend
  // (memory in Sprint 2; Sprint 3 adds postgres). Unknown values throw
  // loudly at boot instead of silently degrading.
  const lifecycle = opts.lifecycleLayer ?? lifecycleStoreLayerFromEnv()

  // FE origins: local Astro + Cloudflare Pages preview/prod (wired via env later)
  app.use(
    "/*",
    cors({
      origin: (origin) => origin,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"]
    })
  )

  // Fail-explicit: config/load defects (bad env, invalid network/wallet)
  // answer in-contract JSON instead of an empty 500.
  app.onError((err, c) => {
    console.error("[pact-api] unhandled:", err)
    return c.json(
      {
        ok: false,
        code: PolicyErrorCode.INTERNAL_ERROR,
        message: "Internal error."
      },
      500
    )
  })

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

  // BER-133: public merchant constants for the confirmation UI (BER-136).
  // Recipient/mint are public devnet addresses (transparency), never secrets.
  app.get("/api/merchant", async (c) => {
    const program = Effect.gen(function* () {
      const registry = yield* MerchantRegistry
      const m = registry.getMerchant()
      return {
        ok: true,
        merchant: {
          merchantId: m.merchantId,
          displayName: m.displayName,
          recipientWallet: m.recipientWallet,
          network: m.network,
          token: "USDC",
          tokenMint: m.supportedTokenMint,
          spendingLimitUsdc: m.spendingLimitUsdc,
          active: m.active
        }
      }
    })
    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(MerchantRegistryLive),
        Effect.provide(PactConfigLive)
      )
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
    const raw =
      typeof body === "object" && body !== null
        ? (body as { text?: unknown })
        : {}
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
      // Optional: blank/parse-fail means "omit" (model default).
      // gpt-5.6-luna rejects explicit temperature values.
      const tempRaw = yield* Config.string("LLM_TEMPERATURE").pipe(
        Config.withDefault("")
      )
      const tempParsed = tempRaw.trim().length === 0 ? NaN : Number(tempRaw)
      const temperature = Number.isFinite(tempParsed) ? tempParsed : undefined
      // Server-only HMAC secret for intent seals (Qodo PR #7).
      // Empty = unconfigured: parse/validate fail explicit, never unsigned.
      const sealSecret = yield* Config.string("INTENT_SEAL_SECRET").pipe(
        Config.withDefault("")
      )
      const ttlRaw = yield* Config.string("INTENT_TTL_SECONDS").pipe(
        Config.withDefault("900")
      )
      const ttlSeconds = Number(ttlRaw)
      // TTL is date arithmetic input: zero/negative mints already-expired
      // intents, huge values throw RangeError defects. Fail in-contract
      // (returned as data — this runs inside Effect.gen).
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 86400) {
        return {
          status: 500,
          body: {
            ok: false,
            code: PolicyErrorCode.PARSER_ERROR,
            message: "INTENT_TTL_SECONDS must be between 1 and 86400."
          }
        } as const
      }
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
        sealSecret,
        llm: { baseUrl, apiKey, model, temperature }
      }
      const result = yield* parsePaymentIntent(shaped.right.text, ctx).pipe(
        Effect.catchAll((e) =>
          Effect.succeed(
            {
              _tag: "ParserFailed",
              code: e.code,
              message: e.message
            } as const
          )
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
      // Server misconfiguration is a logged 500, never a client code.
      if (result.code === PolicyErrorCode.INTERNAL_ERROR) {
        console.error("[pact-api] parser misconfigured:", result.message)
      }
      return {
        status: 500,
        body: {
          ok: false,
          code: result.code,
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

  // BER-134 + BER-135: deterministic validation as a service.
  // Trust chain (Qodo PR #7): schema decode -> seal verify -> policy.
  // A forged or re-signed intent fails at the seal with 400, before policy
  // ever sees it. Success re-seals the VALIDATED intent (status changed).
  // INTERNAL_ERROR (e.g. misconfigured limit) is a logged 500; only
  // user-correctable verdicts are 422.
  app.post("/api/intent/validate", async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        {
          ok: false,
          code: PolicyErrorCode.INVALID_REQUEST,
          message: "Request body must be JSON with an 'intent' field."
        },
        400
      )
    }
    const raw =
      typeof body === "object" && body !== null
        ? (body as { intent?: unknown })
        : {}
    const shaped = Schema.decodeUnknownEither(PaymentIntent)(raw.intent)
    if (shaped._tag === "Left") {
      return c.json(
        {
          ok: false,
          code: PolicyErrorCode.INVALID_REQUEST,
          message: "Body 'intent' must be a canonical PaymentIntent."
        },
        400
      )
    }
    const program = Effect.gen(function* () {
      const cfg = yield* PactConfigService
      const sealSecret = yield* Config.string("INTENT_SEAL_SECRET").pipe(
        Config.withDefault("")
      )
      if (sealSecret.trim().length === 0) {
        console.error("[pact-api] intent sealing not configured")
        return {
          status: 500,
          body: {
            ok: false,
            code: PolicyErrorCode.INTERNAL_ERROR,
            message: "Intent sealing is not configured."
          }
        } as const
      }
      if (!verifyIntentSeal(shaped.right, sealSecret)) {
        return {
          status: 400,
          body: {
            ok: false,
            code: PolicyErrorCode.INVALID_REQUEST,
            message:
              "Intent seal invalid — submit intents only as received from /parse."
          }
        } as const
      }
      const result = yield* validateIntent(shaped.right, {
        merchant: cfg.merchant
      }).pipe(
        Effect.map((intent) => ({ _tag: "Validated", intent }) as const),
        Effect.catchAll((error) =>
          Effect.succeed({ _tag: "Rejected", error } as const)
        )
      )
      if (result._tag === "Validated") {
        // Record the authoritative snapshot: confirmation consumes it
        // exactly once by intent ID (Qodo PR #8 problem 2).
        const store = yield* LifecycleStore
        const sealed = sealIntent(result.intent, sealSecret)
        store.recordValidated(
          sealed.intentId,
          sealed.seal as string,
          sealed.updatedAt
        )
        return {
          status: 200,
          body: {
            ok: true,
            intent: sealed
          }
        } as const
      }
      // Server misconfiguration is a logged 500, never a client code.
      if (result.error.code === PolicyErrorCode.INTERNAL_ERROR) {
        console.error("[pact-api] policy misconfigured:", result.error.message)
        return {
          status: 500,
          body: {
            ok: false,
            code: PolicyErrorCode.INTERNAL_ERROR,
            message: result.error.message
          }
        } as const
      }
      return {
        status: 422,
        body: {
          ok: false,
          code: result.error.code,
          message: result.error.message
        }
      } as const
    })
    const out = await Effect.runPromise(
      program.pipe(Effect.provide(PactConfigLive), Effect.provide(lifecycle))
    )
    if (out.status === 200) {
      return c.json(out.body, 200)
    }
    if (out.status === 422) {
      return c.json(out.body, 422)
    }
    if (out.status === 400) {
      return c.json(out.body, 400)
    }
    return c.json(out.body, 500)
  })

  // BER-137: explicit confirmation boundary (C-006).
  // VALIDATED + sealed + {confirm|cancel} -> CONFIRMED/CANCELLED + event.
  // Policy re-runs on a fresh clock, so expiry between validate and
  // confirm is caught. Tampered payloads break the seal (400) before
  // anything else. Cancelled intents create no transaction — nothing in
  // Sprint 1 creates one at all (Sprint Gate).
  app.post("/api/intent/confirm", async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        {
          ok: false,
          code: PolicyErrorCode.INVALID_REQUEST,
          message: "Request body must be JSON with 'intent' and 'decision'."
        },
        400
      )
    }
    const raw =
      typeof body === "object" && body !== null
        ? (body as { intent?: unknown; decision?: unknown })
        : {}
    const shaped = Schema.decodeUnknownEither(PaymentIntent)(raw.intent)
    if (shaped._tag === "Left") {
      return c.json(
        {
          ok: false,
          code: PolicyErrorCode.INVALID_REQUEST,
          message: "Body 'intent' must be a canonical PaymentIntent."
        },
        400
      )
    }
    if (raw.decision !== "confirm" && raw.decision !== "cancel") {
      return c.json(
        {
          ok: false,
          code: PolicyErrorCode.INVALID_REQUEST,
          message: "Body 'decision' must be 'confirm' or 'cancel'."
        },
        400
      )
    }
    const program = Effect.gen(function* () {
      const cfg = yield* PactConfigService
      const sealSecret = yield* Config.string("INTENT_SEAL_SECRET").pipe(
        Config.withDefault("")
      )
      const result = yield* decideConfirmation(
        shaped.right,
        raw.decision as ConfirmationDecision,
        { merchant: cfg.merchant },
        sealSecret
      ).pipe(
        Effect.map(
          ({ intent, event }) => ({ _tag: "Decided", intent, event }) as const
        ),
        Effect.catchAll((error) =>
          Effect.succeed({ _tag: "Rejected", error } as const)
        )
      )
      if (result._tag === "Decided") {
        return {
          status: 200,
          body: { ok: true, intent: result.intent, event: result.event }
        } as const
      }
      if (
        result.error.code === PolicyErrorCode.INTERNAL_ERROR ||
        result.error.code === PolicyErrorCode.INVALID_REQUEST
      ) {
        // Forgery/misconfiguration surface explicitly; forgery is the
        // client's doing but must never read as a policy verdict.
        if (result.error.code === PolicyErrorCode.INTERNAL_ERROR) {
          console.error(
            "[pact-api] confirmation misconfigured:",
            result.error.message
          )
          return {
            status: 500,
            body: {
              ok: false,
              code: PolicyErrorCode.INTERNAL_ERROR,
              message: result.error.message
            }
          } as const
        }
        return {
          status: 400,
          body: {
            ok: false,
            code: PolicyErrorCode.INVALID_REQUEST,
            message: result.error.message
          }
        } as const
      }
      return {
        status: 422,
        body: {
          ok: false,
          code: result.error.code,
          message: result.error.message
        }
      } as const
    })
    const out = await Effect.runPromise(
      program.pipe(Effect.provide(PactConfigLive), Effect.provide(lifecycle))
    )
    if (out.status === 200) {
      return c.json(out.body, 200)
    }
    if (out.status === 422) {
      return c.json(out.body, 422)
    }
    if (out.status === 400) {
      return c.json(out.body, 400)
    }
    return c.json(out.body, 500)
  })

  // BER-140: deterministic USDC transfer construction (C-009).
  // Trust chain: schema decode -> seal verify -> execution gate
  // (sealed CONFIRMED snapshot, unexpired) -> fresh policy re-run ->
  // build from intent + merchant config. Returns an UNSIGNED transaction
  // for the wallet to sign (BER-141); nothing here signs or broadcasts.
  app.post("/api/tx/build", async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        {
          ok: false,
          code: PolicyErrorCode.INVALID_REQUEST,
          message: "Request body must be JSON with 'intent' and 'sender'."
        },
        400
      )
    }
    const raw =
      typeof body === "object" && body !== null
        ? (body as { intent?: unknown; sender?: unknown })
        : {}
    const shaped = Schema.decodeUnknownEither(PaymentIntent)(raw.intent)
    if (shaped._tag === "Left" || typeof raw.sender !== "string") {
      return c.json(
        {
          ok: false,
          code: PolicyErrorCode.INVALID_REQUEST,
          message: "Body must carry a canonical 'intent' and a 'sender' address."
        },
        400
      )
    }
    const program = Effect.gen(function* () {
      const cfg = yield* PactConfigService
      const sealSecret = yield* Config.string("INTENT_SEAL_SECRET").pipe(
        Config.withDefault("")
      )
      // Gate first: only the current sealed CONFIRMED snapshot builds.
      const gated = yield* assertConfirmed(
        shaped.right,
        sealSecret
      ).pipe(
        Effect.map((intent) => ({ _tag: "Gated", intent }) as const),
        Effect.catchAll((error) =>
          Effect.succeed({ _tag: "Rejected", error } as const)
        )
      )
      if (gated._tag === "Rejected") {
        // Forged input is a 400 (consistent with /validate and /confirm);
        // misconfiguration is a logged 500; policy verdicts are 422.
        const status =
          gated.error.code === PolicyErrorCode.INTERNAL_ERROR
            ? 500
            : gated.error.code === PolicyErrorCode.INVALID_REQUEST
              ? 400
              : 422
        if (status === 500) {
          console.error("[pact-api] build gate failed:", gated.error.message)
        }
        return {
          status,
          body: {
            ok: false,
            code: gated.error.code,
            message: gated.error.message
          }
        } as const
      }
      // Fresh policy re-check (no reseal, no record): config may have
      // changed since confirmation. checkPolicyForBuild answers only
      // "still clean?" over the gated snapshot.
      const rechecked = yield* checkPolicyForBuild(gated.intent, {
        merchant: cfg.merchant
      }).pipe(
        Effect.map((intent) => ({ _tag: "Clean", intent }) as const),
        Effect.catchAll((error) =>
          Effect.succeed({ _tag: "Rejected", error } as const)
        )
      )
      if (rechecked._tag === "Rejected") {
        const status =
          rechecked.error.code === PolicyErrorCode.INTERNAL_ERROR ? 500 : 422
        if (status === 500) {
          console.error(
            "[pact-api] build recheck failed:",
            rechecked.error.message
          )
        }
        return {
          status,
          body: {
            ok: false,
            code: rechecked.error.code,
            message: rechecked.error.message
          }
        } as const
      }
      // Builder INVALID_REQUEST (e.g. malformed sender) is a 400 like other
      // malformed inputs — not a 422 policy verdict (Codex PR #12).
      const built = yield* buildUsdcTransfer({
        intent: gated.intent,
        sender: raw.sender as string,
        merchant: cfg.merchant,
        rpcUrl: cfg.solanaRpcUrl,
        reads: opts.solanaReads
      }).pipe(
        Effect.map((tx) => ({ _tag: "Built", tx }) as const),
        Effect.catchAll((error) =>
          Effect.succeed({ _tag: "Rejected", error } as const)
        )
      )
      if (built._tag === "Rejected") {
        // Malformed builder input (e.g. bad sender) is a 400 like other
        // malformed inputs — not a 422 policy verdict (Codex PR #12).
        const status =
          built.error.code === PolicyErrorCode.INTERNAL_ERROR
            ? 500
            : built.error.code === PolicyErrorCode.INVALID_REQUEST
              ? 400
              : 422
        if (status === 500) {
          console.error("[pact-api] build failed:", built.error.message)
        }
        return {
          status,
          body: {
            ok: false,
            code: built.error.code,
            message: built.error.message
          }
        } as const
      }
      return {
        status: 200,
        body: { ok: true, transaction: built.tx }
      } as const
    })
    const out = await Effect.runPromise(
      program.pipe(
        Effect.provide(PactConfigLive),
        Effect.provide(lifecycle)
      )
    )
    if (out.status === 200) {
      return c.json(out.body, 200)
    }
    if (out.status === 422) {
      return c.json(out.body, 422)
    }
    if (out.status === 400) {
      return c.json(out.body, 400)
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
