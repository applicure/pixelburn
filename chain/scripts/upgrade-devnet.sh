#!/usr/bin/env bash
# Devnet program UPGRADE (not initial deploy). DRY RUN by default; --execute only after the lead's go
# (must ship together with the services redeploy: record_buyback_burn account list changed).
#   ./scripts/upgrade-devnet.sh            # checks cluster, authority, size; prints extend + deploy commands
#   ./scripts/upgrade-devnet.sh --execute  # extends programdata if needed, then upgrades in place
set -euo pipefail
cd "$(dirname "$0")/.."
EXECUTE=0; [[ "${1:-}" == "--execute" ]] && EXECUTE=1
if [[ -n "${DEVNET_RPC_URL:-}" ]]; then URL="$DEVNET_RPC_URL"; LABEL="DEVNET_RPC_URL (redacted)"
elif [[ -n "${SOLANA_RPC_HELIUS_KEY:-}" ]]; then URL="https://devnet.helius-rpc.com/?api-key=${SOLANA_RPC_HELIUS_KEY}"; LABEL="Helius devnet (key redacted)"
else URL="https://api.devnet.solana.com"; LABEL="public devnet"; fi
GENESIS="$(solana genesis-hash --url "$URL" 2>/dev/null || true)"
[[ "$GENESIS" == "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" ]] || { echo "REFUSING: $LABEL is not devnet" >&2; exit 1; }
PAYER=keys/deployer.json; ADMIN=keys/admin.json; PROGRAM_ID=A4uaXC9sU3UrbqcPZL4ZJMd2aKzmo5Rq4yDvRm8gpTS; SO=target/deploy/pixel.so
AUTH="$(solana program show "$PROGRAM_ID" --url "$URL" | awk '/Authority/{print $2}')"
LEN="$(solana program show "$PROGRAM_ID" --url "$URL" | awk '/Data Length/{print $3}')"
NEW="$(wc -c < "$SO" | tr -d ' ')"
echo "rpc: $LABEL | authority on-chain: $AUTH | admin key: $(solana address -k $ADMIN)"
[[ "$AUTH" == "$(solana address -k $ADMIN)" ]] || { echo "upgrade authority mismatch" >&2; exit 1; }
EXTEND=0; if (( NEW > LEN )); then EXTEND=$(( NEW - LEN + 16384 )); fi   # + 16 KiB headroom for future upgrades
echo "programdata: $LEN bytes, new .so: $NEW bytes, extend by: $EXTEND"
echo "payer balance: $(solana balance -k $PAYER --url "$URL")  (buffer needs ~$(solana rent "$NEW" --url "$URL" | awk '{print $3}') SOL temporarily, refunded)"
echo "commands:"
(( EXTEND > 0 )) && echo "  solana program extend $PROGRAM_ID $EXTEND --keypair $ADMIN --url <$LABEL>   # CLI 3.x: extend must be signed (and paid) by the upgrade authority"
echo "  solana program deploy $SO --program-id $PROGRAM_ID --keypair $PAYER --upgrade-authority $ADMIN --url <$LABEL>"
if (( EXECUTE == 0 )); then echo "DRY RUN: nothing sent."; exit 0; fi
(( EXTEND > 0 )) && solana program extend "$PROGRAM_ID" "$EXTEND" --keypair "$ADMIN" --url "$URL"
solana program deploy "$SO" --program-id "$PROGRAM_ID" --keypair "$PAYER" --upgrade-authority "$ADMIN" --url "$URL"
