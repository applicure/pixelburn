#!/usr/bin/env bash
# Approved devnet launch (lead, 2026-11-02): fund -> deploy -> pump coin -> init -> warm-up -> verification -> DEVNET.md.
set -euo pipefail
cd "$(dirname "$0")"
LOG=../devnet-log.json
OUT="${MPB_OUT_DIR:-${TMPDIR:-/tmp}/mpb-devnet-run}"; mkdir -p "$OUT"
wait_s() { node -e "setTimeout(()=>{}, $1*1000)"; }
step() { echo "-- $*"; "$@" || echo "!! FAILED: $*"; }
addlog() { node -e '
const fs=require("fs");const [p,step,sig]=process.argv.slice(1);let a=[];try{a=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}
a.push({step,sig,explorer:`https://explorer.solana.com/tx/${sig}?cluster=devnet`,at:new Date().toISOString()});fs.writeFileSync(p,JSON.stringify(a,null,2));' "$LOG" "$1" "$2"; }

echo "== 1. wait for funding + distribute"; node fund-from-deployer.mjs
SOL_BUYS=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("../.devnet-plan.json","utf8")).solBuys)')

echo "== 2. deploy"
cd .. && DEPLOYER_KEYPAIR=keys/deployer.json ADMIN_KEYPAIR=keys/admin.json ./scripts/deploy-devnet.sh --execute 2>&1 | tee $OUT/mpb-deploy.out | grep -v "^ *Compiling" | tail -8; cd scripts
SIG=$(grep -o 'Signature: [1-9A-HJ-NP-Za-km-z]*' $OUT/mpb-deploy.out | tail -1 | cut -d' ' -f2 || true)
[[ -n "$SIG" ]] && addlog "deploy program (upgrade authority = admin)" "$SIG"
solana program show A4uaXC9sU3UrbqcPZL4ZJMd2aKzmo5Rq4yDvRm8gpTS --url devnet | grep -E "Authority|Program Id"

echo "== 3. pump coin (PXTEST) + buy"
CREATOR_KEYPAIR=../keys/admin.json BUY_SOL=0.8 node pump-devnet.ts --execute | tee $OUT/mpb-pump.out
MINT=$(grep -o 'MINT=[1-9A-HJ-NP-Za-km-z]*' $OUT/mpb-pump.out | head -1 | cut -d= -f2)
CURVE=$(grep -o 'PRICE_SOURCE=curve:[1-9A-HJ-NP-Za-km-z]*' $OUT/mpb-pump.out | head -1 | cut -d: -f2)
addlog "pump create_v2 + buy 0.8 SOL (PXTEST)" "$(grep -o 'sent [1-9A-HJ-NP-Za-km-z]*' $OUT/mpb-pump.out | cut -d' ' -f2)"
echo "MINT=$MINT CURVE=$CURVE" | tee ../.devnet-ids

echo "== 4. initialize"
ADMIN_KEYPAIR=../keys/admin.json MINT=$MINT PRICE_SOURCE=curve:$CURVE TREASURY=$(solana address -k ../keys/treasury.json) \
  KEEPER=$(solana address -k ../keys/keeper.json) MAX_PRICE_AGE_SECS=120 TOKEN_BLOCKS_CAP_PER_HOUR=1000 BUYBACK_CAP_SOL_PER_HOUR=1 \
  node init.ts --execute | tee $OUT/mpb-init.out
grep -o 'sent [1-9A-HJ-NP-Za-km-z]*' $OUT/mpb-init.out | while read -r _ s; do addlog "init.ts (treasury rent / initialize)" "$s"; done

echo "== 5. warm-up: 10 cranks x 65 s (first crank >= 30 s after the seed)"
wait_s 35
node devnet-verify.ts crank 10 65
node devnet-verify.ts status

echo "== verification"
for i in $(seq 1 "$SOL_BUYS"); do step node devnet-verify.ts sol-buy $((i - 1)) 0; done
step node devnet-verify.ts token-buy 0 1
wait_s 35
step node devnet-verify.ts crank 1 0
step node devnet-verify.ts buyback 20000000
step node devnet-verify.ts pause
step node devnet-verify.ts unpause
step node devnet-verify.ts status

MINT=$MINT CURVE=$CURVE node devnet-report.ts
echo "== DONE"
