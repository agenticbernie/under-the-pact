#!/usr/bin/env bash
# BER-129 AC#4 + REQ-S-008: fail if secrets or private keys are staged/committed.
set -euo pipefail

PATTERNS='BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|sk-|xox[bpas]-|AKIA[0-9A-Z]{16}|neon_[a-z0-9_]+|BEGIN SEED|mnemonic.*[a-z]+ [a-z]+ [a-z]+'

# Search tracked files only (respects .gitignore, so .env.local is excluded by design)
if git grep -n -E -i "$PATTERNS" -- ':!package-lock.json' ':!pnpm-lock.yaml' ':!.env.example' ':!scripts/check-no-secrets.sh' ':!README.md'; then
  echo ""
  echo "[check:no-secrets] FAILED — possible secret found above. Remove it before committing."
  exit 1
fi

# .env files must never be tracked
if git ls-files | grep -E '(^|/)\.env($|\.local$|\..*\.local$)'; then
  echo "[check:no-secrets] FAILED — .env file is tracked. Untrack it: git rm --cached <file>"
  exit 1
fi

echo "[check:no-secrets] ok — no secrets in tracked files."
