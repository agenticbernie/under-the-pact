import { describe, expect, it } from "vitest"
import { createMemoryLifecycleStore } from "./lifecycle.js"

describe("lifecycle store (Qodo PR #8 problem 2)", () => {
  it("records, consumes once, then refuses everything", () => {
    const store = createMemoryLifecycleStore()
    expect(store.get("intent_x")).toBeUndefined()

    store.recordValidated("intent_x", "seal-1", "t1")
    expect(store.get("intent_x")?.status).toBe("VALIDATED")

    // Refresh while still VALIDATED updates the snapshot.
    store.recordValidated("intent_x", "seal-2", "t2")
    expect(store.get("intent_x")).toMatchObject({ status: "VALIDATED", seal: "seal-2" })

    expect(
      store.consume("intent_x", "VALIDATED", { status: "CONFIRMED", seal: "seal-3", updatedAt: "t3" })
    ).toBe(true)
    expect(store.get("intent_x")?.status).toBe("CONFIRMED")

    // Second consume fails: single-use.
    expect(
      store.consume("intent_x", "VALIDATED", { status: "CANCELLED", seal: "seal-4", updatedAt: "t4" })
    ).toBe(false)
    expect(store.get("intent_x")?.status).toBe("CONFIRMED")
  })

  it("never revives terminal states via re-validation", () => {
    const store = createMemoryLifecycleStore()
    store.recordValidated("intent_y", "seal-1", "t1")
    expect(store.consume("intent_y", "VALIDATED", { status: "CANCELLED", seal: "seal-2", updatedAt: "t2" })).toBe(true)

    // Re-validating a decided intent is a no-op: still CANCELLED.
    store.recordValidated("intent_y", "seal-3", "t3")
    expect(store.get("intent_y")).toMatchObject({ status: "CANCELLED", seal: "seal-2" })
  })

  it("consume on unknown ids fails", () => {
    const store = createMemoryLifecycleStore()
    expect(
      store.consume("intent_nope", "VALIDATED", { status: "CONFIRMED", seal: "s", updatedAt: "t" })
    ).toBe(false)
  })
})
