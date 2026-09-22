import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { LlmClient, LlmLive } from "./llm.js"

describe("LlmClient", () => {
  it("fails fast with missing key and never touches the network", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* LlmClient
        return yield* client.completeJson(
          { baseUrl: "https://api.openai.com/v1", apiKey: "  ", model: "x" },
          "system",
          "user"
        )
      }).pipe(Effect.provide(LlmLive))
    )
    expect(exit._tag).toBe("Failure")
  })
})
