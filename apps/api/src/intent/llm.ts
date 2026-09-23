import { Data, Effect } from "effect"

/**
 * BER-132 / I-002: thin boundary around an OpenAI-compatible chat API.
 * The LLM only ever sees text in and returns text out — it cannot
 * authorize, sign, or broadcast anything. All payment meaning is assigned
 * by deterministic code in parser.ts, and the canonical schema validates
 * the final intent.
 */

export class LlmError extends Data.TaggedError("LlmError")<{
  reason: "missing_key" | "transport" | "bad_status" | "bad_json" | "timeout"
  message: string
  status?: number
}> {}

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  /**
   * Sampling temperature. Omitted when undefined: newer reasoning models
   * (e.g. gpt-5.6-luna) reject any explicit value and require the default.
   * Set LLM_TEMPERATURE=0 only for models that support it.
   */
  temperature?: number
}

export class LlmClient extends Effect.Service<LlmClient>()("LlmClient", {
  effect: Effect.gen(function* () {
    return {
      /**
       * Complete with forced JSON mode. Returns the raw JSON string.
       * Never logs the key; only lengths flow into errors.
       */
      completeJson: (config: LlmConfig, system: string, user: string) =>
        Effect.gen(function* () {
          if (config.apiKey.trim().length === 0) {
            return yield* new LlmError({
              reason: "missing_key",
              message: "LLM_API_KEY is not configured."
            })
          }
          const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`
          const payload: Record<string, unknown> = {
            model: config.model,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: system },
              { role: "user", content: user }
            ]
          }
          if (config.temperature !== undefined) {
            payload["temperature"] = config.temperature
          }
          const res = yield* Effect.tryPromise({
            try: () =>
              fetch(url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${config.apiKey}`
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(15_000)
              }),
            catch: (cause) =>
              new LlmError({
                reason:
                  cause instanceof DOMException && cause.name === "TimeoutError"
                    ? "timeout"
                    : "transport",
                message: `LLM request failed: ${String(cause).slice(0, 200)}`
              })
          })
          if (!res.ok) {
            // Surface the upstream message (bounded): "HTTP 400" alone
            // is unactionable when a model rejects a parameter.
            const detail = yield* Effect.tryPromise({
              try: () => res.text(),
              catch: () =>
                new LlmError({
                  reason: "bad_status",
                  message: "Could not read the upstream error body.",
                  status: res.status
                })
            })
            return yield* new LlmError({
              reason: "bad_status",
              message: `LLM API returned HTTP ${res.status}: ${detail.slice(0, 200)}`,
              status: res.status
            })
          }
          const body: unknown = yield* Effect.tryPromise({
            try: () => res.json(),
            catch: () =>
              new LlmError({
                reason: "bad_json",
                message: "LLM API response was not JSON."
              })
          })
          // Guard before dereferencing: a 200 with `null` (or a non-object)
          // must become a typed LlmError, never a TypeError defect that
          // bypasses the structured PARSER_ERROR path.
          if (typeof body !== "object" || body === null) {
            return yield* new LlmError({
              reason: "bad_json",
              message: "LLM API response was not an object."
            })
          }
          const content = (body as { choices?: Array<{ message?: { content?: string | null } }> }).choices?.[0]
            ?.message?.content
          if (typeof content !== "string" || content.length === 0) {
            return yield* new LlmError({
              reason: "bad_json",
              message: "LLM API returned no content."
            })
          }
          return content
        })
    }
  })
}) {}

/** Canonical live layer (no dependencies — plain fetch). */
export const LlmLive = LlmClient.Default
