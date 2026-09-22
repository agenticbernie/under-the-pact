import { serve } from "@hono/node-server"
import app from "./app.js"

/**
 * Local dev entry. Neon Functions uses `app` (fetch handler) directly —
 * see neon.ts. This file only boots the same app on a local port.
 */
const port = Number(process.env["API_PORT"] ?? 8787)

console.log(`[pact-api] listening on http://localhost:${port}`)
serve({ fetch: app.fetch, port })
