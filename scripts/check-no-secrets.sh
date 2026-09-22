#!/usr/bin/env bash
# BER-129 AC#4 + REQ-S-008: fail if secrets or private keys are staged/committed.
# Scans BOTH the staged index (--cached, i.e. what will actually be committed)
# and tracked working-tree files, so a secret staged then removed from the
# working copy is still caught (Codex P2).
set -euo pipefail

PATTERNS='BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|sk-|xox[bpas]-|AKIA[0-9A-Z]{16}|BEGIN SEED|mnemonic.*[a-z]+ [a-z]+ [a-z]+'
EXCLUDE_SPEC=" . :(exclude)package-lock.json :(exclude)pnpm-lock.yaml :(exclude).env.example :(exclude)scripts/check-no-secrets.sh :(exclude)README.md"

fail=0

# shellcheck disable=SC2086
if git grep -n -E -i --cached -e "$PATTERNS" -- $EXCLUDE_SPEC 2>/dev/null; then
  echo "[check:no-secrets] FAILED — possible secret in STAGED content above."
  fail=1
fi

# shellcheck disable=SC2086
if git grep -n -E -i -e "$PATTERNS" -- $EXCLUDE_SPEC 2>/dev/null; then
  echo "[check:no-secrets] FAILED — possible secret in working tree above."
  fail=1
fi

# No env file may ever be tracked — every .env* except the template.
if git ls-files | grep -E '(^|/)\.env($|\.|$)' | grep -v -E '(^|/)\.env\.example$'; then
  echo "[check:no-secrets] FAILED — .env file is tracked. Untrack it: git rm --cached <file>"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "[check:no-secrets] FAILED — remove secrets before committing."
  exit 1
fi

echo "[check:no-secrets] ok — no secrets in staged or tracked files."
