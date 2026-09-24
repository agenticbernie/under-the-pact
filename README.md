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
`LLM_BASE_URL`/`LLM_MODEL`/`LLM_TEMPERATURE`/`INTENT_TTL_SECONDS`) for live parsing.

Model notes (verified live 2026-09-22):
- OpenAI `gpt-5.6-luna`: rejects explicit `temperature` — leave
  `LLM_TEMPERATURE` blank (omit = default 1).
- OpenRouter free picks with `temperature: 0` + JSON mode working:
  `nvidia/nemotron-3-super-120b-a12b:free` (most capable, 3/3 stable
  parses), `nex-agi/nex-n2.5-pro:free`, `dots-studio/dots-3-note-preview:free`.
  Google Gemma `:free` variants were upstream-429 at test time.
  Avoid `nemotron-3.5-content-safety:free`: safety classifier, no
  `response_format` support — wrong tool for extraction.
- Free tier = rate-limited upstream, no capacity guarantee: fine for
  dev/demo, not production.

## Merchant registry (BER-133, C-004)

Exactly one merchant, centralized in env and exposed read-only through
`MerchantRegistry` (`apps/api/src/merchant/registry.ts`):
`merchantId, displayName, recipientWallet, network, supportedTokenMint
(= USDC_MINT), spendingLimitUsdc, active`.

Structural guarantee: the module has **no function that accepts a wallet
address** — the only recipient that can flow to policy (BER-134/135),
preflight (BER-139) and tx building (Sprint 2) is the configured merchant
wallet. `MERCHANT_ACTIVE` is a fail-closed kill-switch (only an explicit
true/1/yes activates — omitted or any other value deactivates; policy
then rejects everything).
`GET /api/merchant` publishes the constants for the confirmation UI.

## Policy engine (BER-134 + BER-135, C-005)

Pure `validateIntent(intent, merchant, now)` in `apps/api/src/policy/`:
no UI, LLM, network, or wallet. Fixed check order (first failure wins):
UNKNOWN_MERCHANT → WRONG_NETWORK → WRONG_MINT → NOT_VALIDATED (PARSED
only) → EXPIRED → INVALID_AMOUNT → RECIPIENT_MISMATCH → OVER_LIMIT →
VALIDATED. Amounts and limits compare as integer micro-USDC through the
shared `decimalUsdcToMicro` choke point — never floats. Success returns
the same values with status VALIDATED; Sprint 2 builds transactions from
  exactly these. Served at `POST /api/intent/validate` (malformed bodies
  are 400 INVALID_REQUEST before the engine runs).

  Trust chain (Qodo PR #7): schema decode → HMAC seal verify → policy.
  The parser seals every PARSED intent with server-only `INTENT_SEAL_SECRET`;
  validation rejects forged/unsealed intents with 400 before policy and
  re-seals VALIDATED output (confirmation re-verifies in BER-137). Seal is
  integrity, not authorization — wallet signing remains the auth; Sprint 3's
  intent store replaces seals. Generate with `openssl rand -hex 32`, set it
  in every deployment env (isolates must share it), never commit it.

  Observability (Qodo PR #7): `INTERNAL_ERROR` (e.g. misconfigured
  spending limit — also rejected at config load) is a logged HTTP 500;
  only user-correctable verdicts are 422.

## Confirmation boundary (BER-136 + BER-137, C-001/C-006)

`POST /api/intent/confirm {intent, decision: confirm|cancel}`: seal
verify → VALIDATED-only gate → full policy re-run on a fresh clock
(expiry between validate and confirm is caught) → CONFIRMED/CANCELLED
intent (re-sealed, `confirmedAt` set) + distinct `{type, intentId, actor,
at}` event. Cancel skips policy (backing out always works) and creates
nothing. `assertConfirmed()` is the execution gate Sprint 2's tx builder
must pass: sealed + CONFIRMED + unexpired, else stable codes.

The web summary renders merchant, amount, USDC, network, recipient,
purpose, and expiry from the VALIDATED intent only, with risk info and
Confirm/Cancel controls. Rendering creates and signs nothing.

## Sprint 1 exit

NL request → PARSED → VALIDATED → summary → CONFIRMED/CANCELLED, with
no transaction construction anywhere in the codebase (Sprint Gate).

## What lands next

- BER-130 input UI ✅: NL textarea + client fast-fail + server validation.
- BER-131 intent schema ✅: canonical `PaymentIntent` + fixtures + helpers.
- BER-132 parser ✅: real LLM extraction + deterministic mapping.
- BER-133 merchant registry ✅: single-merchant module + kill-switch.
- BER-134/135 policy engine ✅ (this branch): deterministic validation +
  stable codes + validate endpoint.
- BER-136 summary view ✅ (this branch): validated-only summary + risk info.
- BER-137 confirmation ✅ (this branch): seal/policy-gated boundary +
  CONFIRMED/CANCELLED + events + Sprint 2 execution gate.

Replay note (Qodo PR #8): Sprint 1 is stateless — every decision is
independently verified (seal + VALIDATED-only + fresh policy), and
terminal states cannot be rewritten (confirm/cancel of non-VALIDATED
intents is rejected). Single-use consumption across calls needs the
Sprint 3 lifecycle store (BER-145 audit + BER-146 idempotency), which
replaces seals as the source of truth.
- Sprint 2: wallet adapter, preflight, tx build/sign/submit.
