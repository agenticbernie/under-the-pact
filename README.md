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

Never commit `.env` / `.env.local` / private keys (REQ-S-008).

## Deploy sketch

- API: `neon deploy` (see `neon.ts`, project region `aws-us-east-2`)
- Web: Cloudflare Pages, root `apps/web`, build `pnpm --filter @pact/web build`,
  env `PUBLIC_API_URL=<neon function URL>`, allow origin in Hono CORS.

## What lands next

- BER-130 input UI, BER-131 full intent schema, BER-132 parser stub→real,
  BER-133 merchant registry, BER-138 wallet adapter (Sprint 2).
