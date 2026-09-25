import { Context, Layer } from "effect"

/**
 * Atomic lifecycle store port (Qodo PR #8 problem 2).
 *
 * Decisions must consume the authoritative intent state exactly once:
 * without a lookup, sealed client copies can be replayed into
 * contradictory terminal outcomes (confirm-after-cancel, double-confirm,
 * executing stale copies). The store is keyed by intent ID and tracks the
 * single authoritative status + the seal of the snapshot that set it.
 *
 * Implementations: in-memory below (Sprint 1) → Postgres in Sprint 3
 * (BER-145/146) with no changes to confirm.ts/app.ts. The in-memory
 * adapter is per app instance (single process): correct for local dev and
 * honest about multi-isolate Neon (each isolate holds its own copy —
 * documented, replaced by Postgres in Sprint 3).
 */

export type StoredStatus =
  | "VALIDATED"
  | "CONFIRMED"
  | "CANCELLED"
  | "SUBMITTING"
  | "SUBMITTED"

export interface LifecycleSnapshot {
  status: StoredStatus
  /** Seal of the exact snapshot that set this status. */
  seal: string
  updatedAt: string
}

export interface LifecycleStoreApi {
  get(intentId: string): LifecycleSnapshot | undefined
  /**
   * Record a VALIDATED snapshot — refresh on re-validation.
   * Terminal states are STICKY: re-validating a CONFIRMED/CANCELLED intent
   * neither revives nor overwrites it. Without this, validate-after-decide
   * would resurrect consumed intents and single-use would be fiction.
   */
  recordValidated(intentId: string, seal: string, updatedAt: string): void
  /**
   * Atomically move an expected state -> next. Returns false unless the
   * current record exists and still holds the expected status (single-use).
   * Confirmation consumes VALIDATED; submission reserves CONFIRMED ->
   * SUBMITTING *before* the RPC call (Qodo/Codex PR #14: concurrent
   * retries must never both broadcast) and settles SUBMITTING ->
   * SUBMITTED after acceptance. Synchronous: atomic on Node's single
   * thread; Sprint 3 uses a SERIALIZABLE transaction / advisory lock for
   * the same guarantee across processes.
   */
  consume(
    intentId: string,
    expected: "VALIDATED" | "CONFIRMED" | "SUBMITTING",
    next: {
      status: "CONFIRMED" | "CANCELLED" | "SUBMITTING" | "SUBMITTED"
      seal: string
      updatedAt: string
    }
  ): boolean
}

export const createMemoryLifecycleStore = (): LifecycleStoreApi => {
  const records = new Map<string, LifecycleSnapshot>()
  return {
    get: (intentId) => records.get(intentId),
    recordValidated: (intentId, seal, updatedAt) => {
      const current = records.get(intentId)
      if (current !== undefined && current.status !== "VALIDATED") {
        return
      }
      records.set(intentId, { status: "VALIDATED", seal, updatedAt })
    },
    consume: (intentId, expected, next) => {
      const current = records.get(intentId)
      if (current === undefined || current.status !== expected) {
        return false
      }
      records.set(intentId, { ...next, updatedAt: next.updatedAt })
      return true
    }
  }
}

/**
 * Port: no usable default. Every entry point provides an implementation
 * (memory in Sprint 1, Postgres in Sprint 3) — nothing silently shares
 * global state.
 */
export class LifecycleStore extends Context.Tag("LifecycleStore")<
  LifecycleStore,
  LifecycleStoreApi
>() {}

/** Fresh isolated memory layer: per app instance (tests) / isolate (prod). */
export const lifecycleMemoryLayer = (): Layer.Layer<LifecycleStore> =>
  Layer.succeed(LifecycleStore, createMemoryLifecycleStore())

/**
 * Production selector (Qodo PR #12 problem 3): LIFECYCLE_STORE chooses the
 * backend. Sprint 2 ships memory only — correct for local single-process
 * runs, but each Neon isolate holds its own copy, so validate > confirm >
 * build landing on different isolates cannot share records. Postgres
 * arrives in Sprint 3 (BER-145/146) behind this same variable with no
 * changes to confirm.ts/app.ts. Anything but "memory" fails loudly now
 * instead of silently degrading later.
 */
export const lifecycleStoreLayerFromEnv = (): Layer.Layer<LifecycleStore> => {
  const backend = (process.env["LIFECYCLE_STORE"] ?? "memory")
    .trim()
    .toLowerCase()
  if (backend !== "memory") {
    throw new Error(
      `Unsupported LIFECYCLE_STORE="${backend}": Sprint 3 adds postgres; memory is the only Sprint 2 backend.`
    )
  }
  return lifecycleMemoryLayer()
}
