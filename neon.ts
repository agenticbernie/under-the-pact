// Neon backend-as-code (BER-129).
// Deploy with: neon deploy (branch must be in aws-us-east-2 for Functions beta/GA).
// Hono is the recommended framework: the function serves `apps/api` fetch handler.
import { defineConfig } from "@neondatabase/cli"

export default defineConfig({
  functions: [
    {
      slug: "pact-api",
      // Built entry of apps/api (tsc outDir dist). Neon runs Node 24.
      entry: "apps/api/dist/app.js",
      exportName: "default"
    }
  ]
})
