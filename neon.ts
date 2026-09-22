import { defineConfig } from "@neon/config/v1"

/**
 * Neon backend-as-code (BER-129).
 * Deploy with: pnpm deploy:api  (builds @pact/shared, then `neon deploy`)
 * Local: `neon dev` serves this function with hot reload + injected DATABASE_URL.
 * Project region must be aws-us-east-2 (Functions requirement).
 *
 * Slug rules: ^[a-z0-9]{1,20}$ — permanent after first deploy.
 * NOTE: `source` points at TS source; the CLI bundles it with esbuild.
 * Bundling resolves the @pact/shared workspace import from its built dist,
 * so `pnpm deploy:api` builds shared first (Codex P1: predeploy build).
 */
export default defineConfig({
  preview: {
    functions: {
      pactapi: {
        name: "Pact API",
        source: "./apps/api/src/app.ts",
        env: {
          SOLANA_NETWORK: process.env["SOLANA_NETWORK"] ?? "devnet",
          SOLANA_RPC_URL:
            process.env["SOLANA_RPC_URL"] ?? "https://api.devnet.solana.com",
          USDC_MINT:
            process.env["USDC_MINT"] ??
            "4zMMC9sEqf9MKyRbf3Tx3sQAr1BLWnCQcHjEXtGbm4o",
          MERCHANT_ID: process.env["MERCHANT_ID"] ?? "pact-coffee-demo",
          // Required at runtime (pubkey-validated). Deploy with
          // `neon deploy --env .env.production` so this resolves from file.
          // Empty string keeps the type defined; boot fails with a clear error.
          MERCHANT_WALLET: process.env["MERCHANT_WALLET"] ?? "",
          SPENDING_LIMIT_USDC: process.env["SPENDING_LIMIT_USDC"] ?? "50"
        },
        dev: { port: 8787 }
      }
    }
  }
})
