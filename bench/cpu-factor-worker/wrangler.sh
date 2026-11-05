#!/usr/bin/env bash
# Run wrangler against the account named by the repo's ignored deploy
# credentials, so the owner needs no interactive `wrangler login`.
# Usage: ./wrangler.sh <wrangler subcommand and args...>
#   ./wrangler.sh whoami
#   ./wrangler.sh deploy
# Reads credentials/cloudflare-deploy-free.json ({ api_token, account_id }) by
# default (the S1 probes are valid only on Workers Free); set
# CPU_FACTOR_TIER=paid to read credentials/cloudflare-deploy.json instead.
# CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID already in the environment win.
# The token is exported only into the exec'd wrangler; it is never printed.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
case "${CPU_FACTOR_TIER:-free}" in
  free) file="cloudflare-deploy-free.json" ;;
  paid) file="cloudflare-deploy.json" ;;
  *) echo "wrangler.sh: CPU_FACTOR_TIER must be free or paid" >&2; exit 1 ;;
esac
cred="${CPU_FACTOR_CREDENTIALS_FILE:-$ROOT/credentials/$file}"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  if [ ! -f "$cred" ]; then
    echo "wrangler.sh: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or create credentials/$file as { \"api_token\": \"...\", \"account_id\": \"...\" }" >&2
    exit 1
  fi
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    CLOUDFLARE_API_TOKEN="$(jq -r '.api_token // empty' "$cred")"
  fi
  if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    CLOUDFLARE_ACCOUNT_ID="$(jq -r '.account_id // empty' "$cred")"
  fi
  if [ -z "$CLOUDFLARE_API_TOKEN" ] || [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
    echo "wrangler.sh: credentials/$file must be { \"api_token\": \"...\", \"account_id\": \"...\" }" >&2
    exit 1
  fi
  export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
fi
exec npx wrangler@4 "$@"
