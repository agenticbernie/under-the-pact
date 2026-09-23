import { Data, Effect, Schema } from "effect"
import {
  createIntentId,
  decimalUsdcToMicro,
  PaymentIntent,
  PolicyErrorCode,
  type SolanaNetwork
} from "@pact/shared"
import { LlmClient, type LlmConfig } from "./llm.js"

/**
 * BER-132 / C-002 Intent Parser + C-003 Payment Intent Service (creation half).
 *
 * The LLM proposes raw extraction only. Deterministic code below assigns
 * every payment meaning, fills chain fields from trusted config context
 * (never from the model), and decodes the result through the canonical
 * PaymentIntent schema. The parser can never authorize, validate policy,
 * or execute — it returns data, status PARSED at most.
 */

export interface ParserContext {
  network: SolanaNetwork
  tokenMint: string
  recipientWallet: string
  merchantId: string
  merchantDisplayName: string
  /** Lowercase alias strings the merchant is known by. */
  merchantAliases: string[]
  ttlSeconds: number
  llm: LlmConfig
}

/** Raw extraction contract the model must return (JSON mode). */
const LlmExtraction = Schema.Struct({
  merchantReference: Schema.NullOr(Schema.String),
  amountUsdc: Schema.NullOr(Schema.String),
  tokenMention: Schema.NullOr(Schema.String),
  purpose: Schema.NullOr(Schema.String)
})
type LlmExtraction = typeof LlmExtraction.Type

export interface ParsedIntent {
  readonly _tag: "Parsed"
  readonly intent: PaymentIntent
}

/** Recoverable: user can answer and retry (REQ-F-003). Never proceeds. */
export interface Clarification {
  readonly _tag: "Clarification"
  readonly message: string
  readonly missing: string[]
}

export type ParseResult = ParsedIntent | Clarification

export class ParserError extends Data.TaggedError("ParserError")<{
  code: typeof PolicyErrorCode.PARSER_ERROR
  message: string
}> {}

const clarify = (message: string, missing: string[]): Clarification => ({
  _tag: "Clarification",
  message,
  missing
})

const normalize = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()

/**
 * Exact merchant matching (Codex P1): every significant word of the
 * reference must appear in the alias vocabulary. Substring matching alone
 * lets "Blue Bottle Coffee" resolve via "coffee", and single characters
 * match hyphenated ids — both would stamp the trusted wallet on the
 * wrong payee, undetectable by later policy.
 */
const aliasWords = (aliases: string[]): Set<string> =>
  new Set(
    aliases.flatMap((a) =>
      a.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2)
    )
  )

const matchesMerchant = (refNorm: string, ctx: ParserContext): boolean => {
  if (refNorm.length === 0) {
    return false
  }
  if (ctx.merchantAliases.includes(refNorm)) {
    return true
  }
  const words = refNorm.split(/[^a-z0-9]+/).filter((w) => w.length >= 2)
  if (words.length === 0) {
    return false
  }
  const vocab = aliasWords(ctx.merchantAliases)
  return words.every((w) => vocab.has(w))
}

/**
 * Grounding (Codex P1): payment-critical model values must be evidenced
 * in the source request. A hallucinated amount/token for "Pay Pact Coffee"
 * must never become a valid intent — later policy cannot tell invented
 * values from user-stated ones.
 */
const textAmountMicros = (text: string): Set<number> => {
  const out = new Set<number>()
  for (const m of text.replace(/,/g, "").match(/(\d+(?:\.\d{1,6})?)/g) ?? []) {
    const micro = decimalUsdcToMicro(m)
    if (micro !== null) {
      out.add(micro)
    }
  }
  return out
}

/**
 * Alias set the parser matches merchant mentions against.
 * Context for interpretation only — acceptance is policy's job (BER-134).
 */
export const merchantAliasesFor = (
  displayName: string,
  merchantId: string
): string[] => {
  const words = `${displayName} ${merchantId}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2)
  return [...new Set([merchantId.toLowerCase(), displayName.toLowerCase(), ...words])]
}

/** decimalUsdcToMicro lives in @pact/shared (single money-math choke point). */
export { decimalUsdcToMicro } from "@pact/shared"

const SYSTEM_PROMPT = `You extract payment details from a user's request. You only extract data — you never authorize, approve, or execute payments.

Return ONLY a JSON object with exactly these keys (string or null, no other keys):
{
  "merchantReference": "who the user wants to pay, as written, or null",
  "amountUsdc": "the payment amount as a plain decimal string like \\"5\\" or \\"5.50\\", or null if none is stated",
  "tokenMention": "the currency/token word the user wrote (e.g. \\"USDC\\", \\"SOL\\", \\"$\\"), or null",
  "purpose": "what the payment is for, or null"
}

Rules:
- amountUsdc must be digits with at most 6 decimals, no commas, no currency symbols.
- If no amount is stated, use null — never invent one.
- Copy phrases from the request; never add explanations.`

const buildUserPrompt = (text: string, ctx: ParserContext): string =>
  [
    `Supported merchant: "${ctx.merchantDisplayName}" (id "${ctx.merchantId}").`,
    `Supported token: USDC on Solana ${ctx.network}.`,
    `User request: """${text}"""`
  ].join("\n")

/**
 * Pure mapping: model JSON -> PARSED intent or Clarification.
 * Separated from I/O so it is unit-testable without any LLM call.
 */
export const toIntentProposal = (
  raw: unknown,
  text: string,
  ctx: ParserContext,
  now: Date = new Date()
): ParseResult | { _tag: "ModelError"; message: string } => {
  const decoded = Schema.decodeUnknownEither(LlmExtraction)(raw)
  if (decoded._tag === "Left") {
    return { _tag: "ModelError", message: "Model returned malformed JSON." }
  }
  const ext = decoded.right

  // Merchant: must resolve to the one supported merchant (exact match).
  const ref = ext.merchantReference?.trim() ?? ""
  const refNorm = normalize(ref)
  if (!matchesMerchant(refNorm, ctx)) {
    return clarify(
      `Which merchant? This demo pays "${ctx.merchantDisplayName}" only — try "Pay 5 USDC to ${ctx.merchantDisplayName}".`,
      ["merchant"]
    )
  }

  // Token: must be evidenced in the text, then USDC-only PoC.
  const token = ext.tokenMention?.trim() ?? ""
  if (token.length > 0 && !text.toLowerCase().includes(token.toLowerCase())) {
    return {
      _tag: "ModelError",
      message: "Model token mention not found in request text."
    }
  }
  if (token.length > 0 && !/^(usdc|usd\s*coin|\$)$/i.test(token)) {
    return clarify(
      `This demo supports USDC only (you wrote "${token}"). Try "Pay 5 USDC to ${ctx.merchantDisplayName}".`,
      ["token"]
    )
  }

  // Amount: required, exact decimal.
  if (ext.amountUsdc === null || ext.amountUsdc.trim().length === 0) {
    return clarify(
      "How much? Include an amount, e.g. \"Pay 5 USDC\".",
      ["amount"]
    )
  }
  const micro = decimalUsdcToMicro(ext.amountUsdc)
  if (micro === null) {
    return {
      _tag: "ModelError",
      message: `Model returned an unusable amount: ${ext.amountUsdc.slice(0, 40)}.`
    }
  }
  // Amount grounding: the digits must come from the user's text.
  // No digits at all -> the user stated no amount (clarify, don't invent).
  // Digits present but none matching -> the model invented it (model error).
  const mentioned = textAmountMicros(text)
  if (mentioned.size === 0) {
    return clarify('How much? Include an amount, e.g. "Pay 5 USDC".', [
      "amount"
    ])
  }
  if (!mentioned.has(micro)) {
    return {
      _tag: "ModelError",
      message: "Model amount not found in request text."
    }
  }
  if (micro <= 0) {
    return clarify('Amount must be greater than zero, e.g. "Pay 5 USDC".', [
      "amount"
    ])
  }

  const at = now.toISOString()
  const candidate = {
    intentId: createIntentId(),
    status: "PARSED",
    merchantId: ctx.merchantId,
    amountMicroUsdc: micro,
    token: "USDC",
    tokenMint: ctx.tokenMint,
    network: ctx.network,
    recipient: ctx.recipientWallet,
    // Audit context only (never execution): cap like purpose so a verbose
    // model phrase cannot fail schema decode for otherwise usable input.
    recipientReference: ref.slice(0, 120),
    purpose: ext.purpose?.trim() ? ext.purpose.trim().slice(0, 280) : undefined,
    expiry: new Date(now.getTime() + ctx.ttlSeconds * 1000).toISOString(),
    createdAt: at,
    updatedAt: at
  }
  const intent = Schema.decodeUnknownEither(PaymentIntent)(candidate)
  if (intent._tag === "Left") {
    return { _tag: "ModelError", message: "Proposal failed schema validation." }
  }
  return { _tag: "Parsed", intent: intent.right }
}

export const parsePaymentIntent = (
  text: string,
  ctx: ParserContext
): Effect.Effect<ParseResult, ParserError, LlmClient> =>
  Effect.gen(function* () {
    const llm = yield* LlmClient
    const raw = yield* llm
      .completeJson(ctx.llm, SYSTEM_PROMPT, buildUserPrompt(text, ctx))
      .pipe(
        Effect.mapError(
          (e) =>
            new ParserError({
              code: PolicyErrorCode.PARSER_ERROR,
              message:
                e.reason === "missing_key"
                  ? "LLM is not configured (LLM_API_KEY missing)."
                  : `Intent parsing failed: ${e.message}`
            })
        )
      )
    let extraction: unknown
    try {
      extraction = JSON.parse(raw) as unknown
    } catch {
      return yield* new ParserError({
        code: PolicyErrorCode.PARSER_ERROR,
        message: "Model returned invalid JSON."
      })
    }
    const result = toIntentProposal(extraction, text, ctx)
    if (result._tag === "ModelError") {
      return yield* new ParserError({
        code: PolicyErrorCode.PARSER_ERROR,
        message: result.message
      })
    }
    return result
  })
