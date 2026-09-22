import { afterEach, describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { LlmClient, LlmLive } from "./llm.js"

describe("LlmClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("fails fast with missing key and never touches the network", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
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
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("omits temperature when undefined (reasoning-model compatible)", async () => {
    let sentBody = ""
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: { body?: unknown } | undefined) => {
        sentBody = String(init?.body ?? "")
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      })
    )
    const content = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* LlmClient
        return yield* client.completeJson(
          { baseUrl: "https://example.test", apiKey: "k", model: "m" },
          "system",
          "user"
        )
      }).pipe(Effect.provide(LlmLive))
    )
    expect(content).toBe("{}")
    expect(sentBody).not.toContain("temperature")
  })

  it("forwards an explicit temperature when configured", async () => {
    let sentBody = ""
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: { body?: unknown } | undefined) => {
        sentBody = String(init?.body ?? "")
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      })
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* LlmClient
        return yield* client.completeJson(
          {
            baseUrl: "https://example.test",
            apiKey: "k",
            model: "m",
            temperature: 0
          },
          "system",
          "user"
        )
      }).pipe(Effect.provide(LlmLive))
    )
    expect(JSON.parse(sentBody).temperature).toBe(0)
  })
})
