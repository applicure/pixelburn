#!/usr/bin/env bash
# Devnet deploy for the `pixel` program. DRY RUN by default; pass --execute to deploy.
#   ./scripts/deploy-devnet.sh            # checks toolchain, keys, balance, prints the deploy command + cost
#   ./scripts/deploy-devnet.sh --execute  # builds and deploys to devnet (spends devnet SOL)
# RPC: DEVNET_RPC_URL > SOLANA_RPC_HELIUS_KEY (Helius devnet) > public devnet. SOLANA_RPC is deliberately IGNORED (it is
# the mainnet endpoint in the root .env). Genesis-hash guard: refuses unless the cluster is devnet.
# SOLANA_CLUSTER defaults to devnet (only devnet is accepted). The RPC URL / keys are never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

EXECUTE=0
[[ "${1:-}" == "--execute" ]] && EXECUTE=1
CLUSTER="${SOLANA_CLUSTER:-devnet}"
if [[ "$CLUSTER" != "devnet" ]]; then echo "SOLANA_CLUSTER=$CLUSTER not supported (devnet only)" >&2; exit 1; fi
if [[ -n "${DEVNET_RPC_URL:-}" ]]; then
  URL="$DEVNET_RPC_URL"; URL_LABEL="DEVNET_RPC_URL (redacted)"
elif [[ -n "${SOLANA_RPC_HELIUS_KEY:-}" ]]; then
  URL="https://devnet.helius-rpc.com/?api-key=${SOLANA_RPC_HELIUS_KEY}"; URL_LABEL="Helius devnet (key redacted)"
else
  URL="https://api.devnet.solana.com"; URL_LABEL="public devnet endpoint"
fi
# DEPLOYER pays for the deploy; ADMIN becomes the upgrade authority (initialize requires admin == upgrade authority).
ADMIN="${ADMIN_KEYPAIR:-keys/admin.json}"
WALLET="${DEPLOYER_KEYPAIR:-keys/deployer.json}"
[[ -f "$ADMIN" ]] || ADMIN="$HOME/.config/solana/id.json"
[[ -f "$WALLET" ]] || WALLET="$ADMIN"
PROGRAM_KP="${PROGRAM_KEYPAIR:-target/deploy/pixel-keypair.json}"

if [[ "$URL" == *mainnet* ]]; then echo "refusing: mainnet RPC" >&2; exit 1; fi
DEVNET_GENESIS="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
GENESIS="$(solana genesis-hash --url "$URL" 2>/dev/null || true)"
if [[ "$GENESIS" != "$DEVNET_GENESIS" ]]; then
  echo "REFUSING: $URL_LABEL is not devnet (genesis '${GENESIS:-unreachable}', expected $DEVNET_GENESIS)" >&2; exit 1
fi
command -v anchor >/dev/null || { echo "anchor not installed" >&2; exit 1; }
command -v solana >/dev/null || { echo "solana cli not installed" >&2; exit 1; }
echo "anchor:  $(anchor --version)"
echo "solana:  $(solana --version)"
echo "rpc:     $URL_LABEL"
echo "payer:   $WALLET"
echo "admin / upgrade authority: $ADMIN"
[[ -f "$WALLET" ]] || { echo "missing payer keypair $WALLET" >&2; exit 1; }
[[ -f "$ADMIN" ]] || { echo "missing admin keypair $ADMIN" >&2; exit 1; }
[[ -f "$PROGRAM_KP" ]] || { echo "missing $PROGRAM_KP (run anchor build / restore the program keypair)" >&2; exit 1; }

PROGRAM_ID="$(solana address -k "$PROGRAM_KP")"
DECLARED="$(grep -o 'declare_id!("[^"]*")' programs/pixel/src/lib.rs | sed 's/declare_id!("\(.*\)")/\1/')"
echo "program: $PROGRAM_ID (declare_id: $DECLARED)"
if [[ "$PROGRAM_ID" != "$DECLARED" ]]; then
  echo "program keypair and declare_id! differ: run 'anchor keys sync' then rebuild, and re-sync the SDK IDL" >&2
  exit 1
fi

if [[ $EXECUTE -eq 1 ]]; then anchor build; fi
SO="target/deploy/pixel.so"
[[ -f "$SO" ]] || { echo "missing $SO, run anchor build" >&2; exit 1; }
SIZE=$(wc -c <"$SO" | tr -d ' ')
# Solana CLI errors can echo the URL, so their stderr is discarded here.
RENT="$(solana rent $((SIZE * 2 + 45)) --url "$URL" 2>/dev/null | head -1 || true)"
BAL="$(solana balance "$(solana address -k "$WALLET")" --url "$URL" 2>/dev/null || true)"
echo "so size: $SIZE bytes; upper-bound programdata rent (2x size): ${RENT:-n/a}"
echo "balance: ${BAL:-n/a}"

cat <<'WARN'

LAUNCH REQUIREMENT (audit M-2.1): `initialize` requires admin == upgrade authority, so whoever holds that key can
upgrade the program and take the buyback vault and auction escrow. Before mainnet, move BOTH the upgrade authority
and the admin role to a timelocked Squads multisig:
  solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <SQUADS_VAULT> (after initialize)
  propose_admin(<SQUADS_VAULT>) + accept_admin from the multisig
or make the program immutable (--final). Devnet is exempt.
WARN

echo
echo "deploy command (URL redacted):"
echo "  solana program deploy $SO --program-id $PROGRAM_KP --keypair $WALLET --upgrade-authority $ADMIN --url <$URL_LABEL>"
if [[ $EXECUTE -eq 0 ]]; then
  echo
  echo "DRY RUN: nothing deployed. Re-run with --execute. Then: (cd scripts && pnpm install --ignore-workspace && node init.ts)"
  exit 0
fi
solana program deploy "$SO" --program-id "$PROGRAM_KP" --keypair "$WALLET" --upgrade-authority "$ADMIN" --url "$URL" 2> >(sed "s#${URL//#/\\#}#<rpc>#g" >&2)
echo "deployed $PROGRAM_ID. Next: cd scripts && node init.ts (dry run) then node init.ts --execute"
