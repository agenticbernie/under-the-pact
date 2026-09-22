# Pact — BER-129 Solana PoC Workspace & Environment

Confirmation-first AI payment agent for controlled USDC payments on Solana.
Issue: `BER-129`. Sprint: `BER-126 Sprint 1 — Foundation & Payment Intent`.

## Stack (locked)

| Slice | Tech | Deploy |
|---|---|---|
| Frontend | Astro static + React islands | Cloudflare Pages |
| Backend | Hono + Effect (Schema/Config/Layer) | Neon Functions (Node 24, `aws-us-east-2`) |
| DB | Neon Postgres (Lakebase) | Neon branch |
| Shared | `@pact/shared` Effect Schema + error codes | workspace |

Trust boundary (PRD §9): AI proposes → deterministic code validates →
user confirms → wallet signs → Solana verifies. No tx is created before
explicit confirmation (Sprint 1 Gate).

## Quickstart

```bash
cp .env.example .env
pnpm install
pnpm dev
# web: http://localhost:4321 — api: http://localhost:8787/api/health
```

`pnpm dev` / `pnpm test` auto-build `@pact/shared` first (pre-scripts),
because the API imports it from built `dist`. The API loads the
monorepo-root `.env` via dotenv; on Neon Functions vars are injected.

Single-slice dev:

```bash
pnpm dev:api
pnpm dev:web
```

## Checks (must be green)

```bash
pnpm --filter @pact/shared build && pnpm --filter @pact/api build
pnpm test
pnpm lint
pnpm check:no-secrets
```

Sprint Gate guard — must print nothing (no tx construction in Sprint 1):

```bash
grep -r "Transaction\|signAndSend\|sendTransaction\|signTransaction" apps packages --include="*.ts" --include="*.astro" || echo "gate ok"
```

## Env

All payment constants are env-driven (`apps/api/src/config.ts`, fail-fast):
`SOLANA_NETWORK, SOLANA_RPC_URL, USDC_MINT, MERCHANT_ID,
MERCHANT_DISPLAY_NAME, MERCHANT_WALLET, SPENDING_LIMIT_USDC, DATABASE_URL`.

Neon Functions injects `DATABASE_URL` on deploy. Locally `/api/health`
works with `db: not-configured` until a Neon branch exists.

`MERCHANT_WALLET` is required and pubkey-validated at boot — a missing or
placeholder wallet fails startup instead of reporting healthy. The
`.env.example` dummy is the system program address (format-valid only);
replace it with the real devnet recipient before the demo (BER-133 locks it).

Never commit any `.env*` file (only `.env.example` is tracked) or private keys (REQ-S-008).

## PaymentIntent contract (BER-131, SRS §16.5)

Canonical schema: `packages/shared/src/schema.ts` (`PaymentIntent`).
Fixtures: `packages/shared/src/fixtures.ts`.

| Field | Required | Notes |
|---|---|---|
| intentId | yes | `intent_<id>`, via `createIntentId()` |
| status | yes | lifecycle enum; transitions enforced by BER-137 |
| merchantId | yes | must be registered (BER-134 rejects unknown) |
| amountMicroUsdc | yes | integer micro-USDC, no floats; policy enforces limit (BER-135) |
| token | yes | always `USDC` |
| tokenMint | yes | must equal configured mint (BER-134) |
| network | yes | devnet / testnet / mainnet-beta |
| recipient | yes | must equal merchant wallet (BER-135 rejects arbitrary) |
| recipientReference | no | raw mention from user text, audit only |
| purpose | no | user memo, max 280 chars |
| userWallet | no | unknown until wallet connects (Sprint 2) |
| expiry / createdAt / updatedAt | yes | ISO-8601 UTC; expiry enforced by policy (BER-135) |

Pure helpers: `createIntentId`, `formatMicroUsdc`, `isExpired` — no UI/LLM
imports. Every consumer (parser BER-132, policy BER-134/135, UI BER-136,
execution Sprint 2) decodes through this schema; AI/client output is
untrusted until it passes. Rejections map to stable `PolicyErrorCode`.

## Deploy sketch

- API: `pnpm deploy:api` (builds `@pact/shared`, then `neon deploy` —
  the CLI bundles `apps/api/src` with esbuild, so shared must be built;
  see `neon.ts`, function slug `pactapi`, project region `aws-us-east-2`).
  Needs the `neon` CLI (`npm i -g neon@latest`, also a workspace devDep)
  and a linked project (`neon link`). Pass secrets via
  `neon deploy --env .env.production`.
  Local function dev: `neon dev` (hot reload + injected `DATABASE_URL`).
- Web: Cloudflare Pages, root `apps/web`, build `pnpm --filter @pact/web build`,
  env `PUBLIC_API_URL=<neon function URL>`, allow origin in Hono CORS.

## Intent parser (BER-132, REQ-F-002/003/004)

`POST /api/intent/parse`: shape validation (400) → real LLM extraction
(JSON mode, temperature 0) → deterministic mapping → canonical PARSED
intent (200), recoverable clarification (422 AMBIGUOUS_REQUEST + missing
fields), or ParserError (500 PARSER_ERROR — always distinguishable from
policy rejections in BER-134/135).

Trust rules: the model proposes raw fields only; chain data (network,
mint, recipient) comes from trusted config, never the model; the key
stays server-side via `LLM_*` env; `LlmClient` is the single seam, so
tests stub it and CI needs no key. Set `LLM_API_KEY` (+ optional
`LLM_BASE_URL`/`LLM_MODEL`/`INTENT_TTL_SECONDS`) for live parsing.

## What lands next

- BER-130 input UI ✅: NL textarea + client fast-fail + server validation.
- BER-131 intent schema ✅: canonical `PaymentIntent` + fixtures + helpers.
- BER-132 parser ✅ (this branch): real LLM extraction + deterministic mapping.
- BER-133 merchant registry, BER-134/135 policy engine,
  BER-138 wallet adapter (Sprint 2).
