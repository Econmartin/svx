#!/usr/bin/env bash
# Export the active sui CLI keypair as a bech32 private key, for use in
# Coolify's SUI_PRIVATE_KEY_BECH32 env var.
#
# WARNING: this prints your private key to stdout. Pipe to clipboard, paste
# into Coolify's secret field, then clear your scrollback.
#
# Usage:
#   ./scripts/export-operator-key.sh
#   ./scripts/export-operator-key.sh | pbcopy   # macOS

set -euo pipefail

addr=$(sui client active-address)
echo "# Active address: $addr" >&2
echo "# Copy the next line into Coolify (env var: SUI_PRIVATE_KEY_BECH32)" >&2
sui keytool export --key-identity "$addr" --json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["exportedPrivateKey"])'
