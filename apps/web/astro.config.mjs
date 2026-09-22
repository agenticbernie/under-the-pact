import { defineConfig } from "astro/config"
import react from "@astrojs/react"

// Static output for Cloudflare Pages (BER-129).
// Wallet islands mount with client:only in later issues (BER-138).
export default defineConfig({
  output: "static",
  integrations: [react()],
  server: { port: 4321 }
})
