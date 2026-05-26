#!/bin/bash
# Run before every deploy
set -e
echo "Running npm audit..."
npm audit --audit-level=high
echo "Checking for hardcoded secrets..."
if grep -rn --include="*.js" --exclude-dir=node_modules -e "sk_live_" -e "sk_test_" .; then
  echo "ERROR: Possible hardcoded Stripe keys found"
  exit 1
fi
echo "Security check passed"
