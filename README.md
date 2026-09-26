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
- BER-136 summary view ✅: validated-only summary + risk info.
- BER-137 confirmation ✅: seal/policy-gated boundary +
  CONFIRMED/CANCELLED + events + Sprint 2 execution gate.

Replay note (Qodo PR #8): decisions consume a server-side lifecycle
store keyed by intent ID (`apps/api/src/policy/lifecycle.ts`) — each
intent decides exactly once (replays get DUPLICATE_INTENT), terminal
states are sticky across re-validation, and the execution gate checks
the stored CONFIRMED snapshot instead of trusting client copies. The
Sprint 1 adapter is per app instance/isolate; Sprint 3 (BER-145/146)
swaps in Postgres with no changes to confirm.ts/app.ts.

## Sprint 2 kickoff — Controlled Solana USDC Payment (BER-128)
Scope: wallet connection → network/balance preflight → USDC transfer
build from CONFIRMED intents only → user wallet signing → submission →
signature capture. Issues: BER-138 wallet adapter, BER-139 preflight,
BER-140 tx build, BER-141 signing flow, BER-142 submit.

Exit: one real USDC payment submittable on Solana devnet from an
approved intent. Standing rules carry over: confirmation-first (nothing
builds without a sealed CONFIRMED intent via assertConfirmed), no
private-key custody, deterministic code owns policy, Solana is the
source of truth for execution.

## Wallet adapter (BER-138, C-007)
One supported wallet (Phantom) via `@solana/wallet-adapter-react` in a
`client:only` island (`apps/web/src/components/`). Connection states
(disconnected/connecting/connected), address display, and explicit
unsupported-wallet/network/mismatch states; no signing calls here
(signing is BER-141). Keys never leave the wallet by construction.
Frontend network comes from `PUBLIC_SOLANA_NETWORK` (+ optional
`PUBLIC_SOLANA_RPC_URL` override) and is cross-checked against the
backend policy network from `/api/merchant` — both must match devnet
for the PoC demo. Two review hardening (PR #10): the RPC endpoint's
genesis hash is probed and must match the selected cluster (a mainnet
override blocks the wallet UI — real-money risk), and backend-network
verification is an explicit loading/verified/error tri-state (failures
show an alert, never a silent match). Disconnecting an unsupported
wallet also clears the adapter selection so the chooser reopens.

## Preflight checks (BER-139, C-008)
Client-side reads after CONFIRMED (`PreflightPanel` island, listening for
`pact:confirmed`): wallet connected, cluster genesis match, SOL fee
reserve (>= 0.005), USDC token account + balance vs the approved amount.
Authority order: the sealed intent's network governs (frontend/backend
disagreement fails explicitly); genesis mismatches block; probe and RPC
failures report RPC_UNREACHABLE, never WRONG_NETWORK/NO_USDC_ACCOUNT
(confirmed absence via getAccountInfo is the only path to NO_USDC_ACCOUNT).
Stale runs are discarded by generation guard and every result carries the
intent ID; disconnect revokes, account switch reruns, and a Re-check
button retries the stored intent. Stable codes (WALLET_NOT_CONNECTED, WRONG_NETWORK,
RPC_UNREACHABLE, INSUFFICIENT_SOL, NO_USDC_ACCOUNT, INSUFFICIENT_USDC)
with actionable messages; failed preflight blocks signing (BER-141 gates
on it). Pure reads only — nothing here can create a transaction.

## Transaction builder (BER-140, C-009)

Deterministic server-side construction: sealed CONFIRMED intent (gated
via assertConfirmed) + fresh policy re-run + sender + merchant config +
chain reads (mint decimals, merchant ATA existence, blockhash) → unsigned
base64 `Transaction` (TransferChecked, feePayer = sender). Served at
`POST /api/tx/build {intent, sender}`: 400 forged/malformed, 422 policy
and MERCHANT_ATA_MISSING (merchant ATA must be pre-created before the
demo — creating it inside the payment would silently charge rent),
500 + logged on RPC/config failures.

The builder can never sign or broadcast (no signer imports; empty
signatures by construction) and derives every execution-critical field
from the sealed intent + merchant config — including an exact integer
micro-USDC amount with chain-read decimals. Sender must equal the bound
wallet when the intent carries one. The web build card renders the full
unsigned details for inspection; signing lands in BER-141.

## Review hardening (PR #12, Qodo + Codex)

- Mint precision: builder requires exactly 6 decimals (micro-USDC is
  six-decimal by definition); anything else is INTERNAL_ERROR, and
  builder INVALID_REQUEST (e.g. malformed sender) maps to 400.
- CONFIRMED stays out of public validation: re-checks at build go through
  internal checkPolicyForBuild (no reseal/record), so the lifecycle store
  never disagrees with a returned snapshot.
- Lifecycle store: LIFECYCLE_STORE selects the backend (memory in Sprint 2;
  Postgres in Sprint 3 with no caller changes). Memory is per isolate —
  demo locally (single process) or accept single-isolate behavior; unknown
  values fail boot loudly.
- Web build card: preflight failures keep the confirmed intent for retry;
  build responses render only for the still-current intent + sender.

## Wallet signing flow (BER-141, C-007)

`SigningPanel` island: enabled only when confirmation + preflight +
unsigned build line up on the same intent, sender, and connected wallet
(pure canSign gate, re-checked at click time). The wallet popup signs
the user-reviewed transaction — Pact never sees a private key, only the
signed bytes (emitted as `pact:signed` for BER-142 submission) or a
rejection. States: signing / signed-ready / rejected-safe /
error — rejection creates no payment and submits nothing. Stale
responses are discarded by generation guard.

## Signing review hardening (PR #13, Qodo + Codex)

- Browser-safe base64 helpers (no Node Buffer in shipped UI code) plus the
  `buffer` polyfill for web3.js internals at the island entry — the popup
  previously never opened in real browsers.
- Post-sign verification: message bytes must equal the reviewed build,
  feePayer must equal the expected sender, and signatures must verify
  cryptographically; otherwise the result is an error, never pact:signed.
- Rejection is proven by code/message (4001 etc.), never by the generic
  WalletSignTransactionError class alone.
- Staged intent carries its expiry: signing past it is blocked (execution
  would reject as EXPIRED anyway).
- Wallet changes retire staged/signed state; rebuilds invalidate via
  pact:build-invalidated; all async responses are generation-guarded.
- Tests may use ephemeral in-memory keypairs (never shipped); shipped
  sources must contain no key material at all.

## Transaction submission (BER-142, C-010)

`POST /api/tx/submit {intent, signedTransaction}`: schema decode >
seal verify > execution gate (stored CONFIRMED snapshot) > broadcast
signed bytes (simulation-enabled send) > consume CONFIRMED→SUBMITTED
(single-use: replays get DUPLICATE_INTENT) > record PaymentAttempt.
Unsigned/undecodable payloads are 400 and never broadcast; RPC failures
record FAILED attempts (intent stays CONFIRMED for retry) and return 500,
never success. The response carries the signature with status SUBMITTED —
pending only, never verified success (Sprint 3 verifies on-chain).
Attempts live in-process in Sprint 2 (Postgres in Sprint 3). The web
submit card shows pending + signature with an explicit not-success
warning; failures keep retry available.

## Submission review hardening (PR #14, Qodo + Codex)

- Submitted bytes must BE the authorized build: fee payer, program,
  TransferChecked layout, exact amount/precision, derived ATAs, and
  cryptographic signature validity — else 400 pre-broadcast.
- Reserve-before-broadcast: CONFIRMED→SUBMITTING is consumed atomically
  before the RPC call; concurrent retries can never both reach Solana.
- Broadcast errors are INDETERMINATE (new code SUBMISSION_INDETERMINATE
  with the would-be signature for explorer reconciliation), never silent
  success and never an auto-restore that could double-send.
- DUPLICATE_INTENT answers carry the recorded attempt so the UI restores
  pending instead of claiming failure; submit stays disabled.
- Web submit card retires signed payloads on preflight/wallet transitions
  and generation-guards intent + sender on every response.
- Durable Postgres for lifecycle + attempts arrives in Sprint 3
  (BER-145/146); LIFECYCLE_STORE already selects the backend.

## Integration review hardening (PR #15, Qodo)

- Rejected/failed signing preserves the staged build with a gated retry
  button (no more restart-the-payment dead ends).
- verifySignedTransfer requires the exact ten-byte TransferChecked
  payload (truncated data is INVALID_REQUEST, never a RangeError defect).
- Durable Postgres for lifecycle + attempts stays Sprint 3 scope
  (BER-145/146): no live Neon project exists yet, so an untestable
  adapter would be worse than the explicit LIFECYCLE_STORE seam; local
  single-process demo is unaffected.

## Submission review hardening (PR #14, Qodo + Codex)

- verifySignedTransfer binds bytes to intent (fee payer, SPL program,
  TransferChecked layout, exact amount/precision, derived ATAs, crypto
  validity) — 400 pre-broadcast, tested incl. foreign-program cases.
- Reserve CONFIRMED>SUBMITTING atomically before the RPC call; settle to
  SUBMITTED only after acceptance. Broadcast errors are INDETERMINATE
  with the would-be signature (no auto-restore, no blind rebuild).
- DUPLICATE_INTENT answers carry the recorded attempt (signature included)
  so the UI restores pending; INDETERMINATE stays disabled for reconcile.
- Fresh policy re-check (kill-switch/limits/recipient) and backend
  genesis check run before reserving — misconfig can no longer slip
  between confirm and submit.
- Web submit retires signed payloads on preflight/wallet/sender changes
  and generation-guards intent + sender on every response.
