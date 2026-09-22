import { describe, expect, it } from "vitest"
import { createApp } from "./app.js"

describe("api skeleton (BER-129)", () => {
  it("GET /api/health returns ok + network", async () => {
    const app = createApp()
    const res = await app.request("/api/health")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; network: string }
    expect(body.ok).toBe(true)
    expect(typeof body.network).toBe("string")
  })

  it("POST /api/intent/parse is 501 until BER-132", async () => {
    const app = createApp()
    const res = await app.request("/api/intent/parse", { method: "POST" })
    expect(res.status).toBe(501)
  })
})
