import { config as loadEnv } from "dotenv"
import { serve } from "@hono/node-server"
import app from "./app.js"

// Load the monorepo-root .env for local runs (Codex P2: quickstart copies
// .env.example -> .env, so the API must actually read it).
// pnpm --filter runs with cwd = apps/api, hence the explicit root path.
// On Neon Functions DATABASE_URL etc. are injected; missing file is a no-op.
loadEnv({ path: new URL("../../../.env", import.meta.url) })

/**
 * Local dev entry. Neon Functions uses `app` (fetch handler) directly —
 * see neon.ts. This file only boots the same app on a local port.
 */
const port = Number(process.env["API_PORT"] ?? 8787)

console.log(`[pact-api] listening on http://localhost:${port}`)
serve({ fetch: app.fetch, port })
