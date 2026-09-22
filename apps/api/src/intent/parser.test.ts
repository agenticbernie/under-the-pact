import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { LlmClient, LlmError } from "./llm.js"
import {
  decimalUsdcToMicro,
  parsePaymentIntent,
  toIntentProposal,
  type ParserContext
} from "./parser.js"

const ctx: ParserContext = {
  network: "devnet",
  tokenMint: "4zMMC9sEqf9MKyRbf3Tx3sQAr1BLWnCQcHjEXtGbm4o",
  recipientWallet: "11111111111111111111111111111111",
  merchantId: "pact-coffee-demo",
  merchantDisplayName: "Pact Coffee Demo",
  merchantAliases: ["pact-coffee-demo", "pact coffee demo", "pact", "coffee", "demo"],
  ttlSeconds: 900,
  llm: { baseUrl: "https://example.test", apiKey: "test", model: "test" }
}

const extraction = (patch: Record<string, string | null>) => ({
  merchantReference: "Pact Coffee",
  amountUsdc: "5",
  tokenMention: "USDC",
  purpose: "oat latte",
  ...patch
})

const stubLlm = (reply: string | LlmError) =>
  // Test double: plain object cast to the service brand (runtime shape matches).
  Layer.succeed(
    LlmClient,
    {
      completeJson: () =>
        reply instanceof LlmError ? Effect.fail(reply) : Effect.succeed(reply)
    } as unknown as LlmClient
  )

describe("decimalUsdcToMicro (pure)", () => {
  it("converts exact decimals without floats", () => {
    expect(decimalUsdcToMicro("5")).toBe(5_000_000)
    expect(decimalUsdcToMicro("5.50")).toBe(5_500_000)
    expect(decimalUsdcToMicro("0.000001")).toBe(1)
    expect(decimalUsdcToMicro("0")).toBe(0)
  })
  it("rejects malformed amounts", () => {
    for (const bad of ["abc", "5.1234567", "1,000", "$5", "", "5.", ".5", "-5"]) {
      expect(decimalUsdcToMicro(bad), bad).toBeNull()
    }
  })
})

describe("toIntentProposal (pure, no LLM)", () => {
  const now = new Date("2030-01-01T00:00:00.000Z")

  it("builds a schema-valid PARSED intent", () => {
    const result = toIntentProposal(extraction({}), "Pay 5 USDC", ctx, now)
    expect(result._tag).toBe("Parsed")
    if (result._tag !== "Parsed") {
      return
    }
    expect(result.intent.status).toBe("PARSED")
    expect(result.intent.amountMicroUsdc).toBe(5_000_000)
    expect(result.intent.merchantId).toBe("pact-coffee-demo")
    expect(result.intent.expiry).toBe("2030-01-01T00:15:00.000Z")
  })

  it("asks for the amount when missing", () => {
    const result = toIntentProposal(extraction({ amountUsdc: null }), "Pay Pact Coffee", ctx, now)
    expect(result._tag).toBe("Clarification")
    if (result._tag === "Clarification") {
      expect(result.missing).toContain("amount")
    }
  })

  it("rejects non-USDC tokens as clarification", () => {
    const result = toIntentProposal(extraction({ tokenMention: "SOL" }), "Pay 5 SOL", ctx, now)
    expect(result._tag).toBe("Clarification")
    if (result._tag === "Clarification") {
      expect(result.missing).toContain("token")
    }
  })

  it("asks which merchant when unmatched", () => {
    const result = toIntentProposal(
      extraction({ merchantReference: "Starbucks" }),
      "Pay 5 USDC to Starbucks",
      ctx,
      now
    )
    expect(result._tag).toBe("Clarification")
    if (result._tag === "Clarification") {
      expect(result.missing).toContain("merchant")
    }
  })

  it("treats zero as a user error, not a model error", () => {
    const result = toIntentProposal(extraction({ amountUsdc: "0" }), "Pay 0 USDC", ctx, now)
    expect(result._tag).toBe("Clarification")
  })

  it("flags malformed model JSON as ModelError", () => {
    const result = toIntentProposal({ nonsense: 1 }, "Pay 5 USDC", ctx, now)
    expect(result._tag).toBe("ModelError")
  })
})

describe("parsePaymentIntent (stubbed LLM)", () => {
  it("returns Parsed for good model output", async () => {
    const result = await Effect.runPromise(
      parsePaymentIntent("Pay 5 USDC to Pact Coffee", ctx).pipe(
        Effect.provide(stubLlm(JSON.stringify(extraction({}))))
      )
    )
    expect(result._tag).toBe("Parsed")
  })

  it("maps model garbage to ParserError (distinguishable from policy)", async () => {
    const result = await Effect.runPromiseExit(
      parsePaymentIntent("Pay 5 USDC", ctx).pipe(
        Effect.provide(stubLlm("definitely not json"))
      )
    )
    expect(result._tag).toBe("Failure")
  })

  it("maps LLM transport failure to ParserError", async () => {
    const result = await Effect.runPromiseExit(
      parsePaymentIntent("Pay 5 USDC", ctx).pipe(
        Effect.provide(
          stubLlm(new LlmError({ reason: "transport", message: "down" }))
        )
      )
    )
    expect(result._tag).toBe("Failure")
  })
})
