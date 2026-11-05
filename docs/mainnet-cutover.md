# Mainnet cutover and launch day

Goal: under 4 minutes from the owner handing over the mint to the site accepting mainnet SOL purchases. All build-time work happens before the coin exists. Once the mint arrives nothing is rebuilt, restarted or edited: services read the mint from the on-chain `Config` and the site flips by itself.

Nothing here has run on mainnet. Rehearsal numbers are at the end.

Apps (Coolify): api `xvlz2veeyem2wmwl2wp7yiwt`, web `bmo4kdaoxkyzvjmrxenootrr`, indexer `ymqskn1mdvofamqrvsagqdjk`, keeper `tmjd8oi0tegozxrplcveegzj`. Database today: `pixelburn-db` (`72ukjfjrfpmftkq88r0hhwqe`, postgres:17-alpine), which holds the devnet rows.

```sh
cd chain/scripts
export MAINNET_RPC_URL=...      # the root .env's SOLANA_RPC, passed explicitly. SOLANA_RPC itself is never read.
export MAINNET_RPC_URL_2=...    # a second provider, e.g. Helius mainnet: failover for init
```

## 1. Program (any time before launch)

Push the commit first: the verified build and the registry check against the public repo.

```sh
node mainnet-launch.ts                                                         # dry run of everything
node mainnet-launch.ts --through verify-deploy --execute --mainnet-i-understand
```

Runs preflight, reproducible build (Docker must be running), fund keeper + uploader + treasury rent, keeper lookup table, deploy with buffer refund, hash check, then prints READY. A re-run skips what's done. `node mainnet-launch.ts --status` shows progress; `node mainnet-deploy.ts --close-buffer` abandons a partial deploy and refunds it.

## 2. Pre-launch switch (well before the coin, allow 30 min)

Devnet stops being served from here on. Take the steps in order. `node mainnet-env.ts` prints the values; `--write-secrets <dir>` writes the two secret bodies to files (mode 600) so they never pass through a terminal. Delete those files afterwards.

### Database: fresh, never reused
1. Stop the indexer and keeper apps so nothing writes.
2. Back up devnet, and check the dump isn't empty before going on:
   `docker exec <pixelburn-db container> pg_dump -U pixelburn -Fc pixelburn > pixelburn-devnet-$(date +%F).dump`
3. Create a NEW Coolify Postgres resource, `pixelframe-mainnet-db`, on the same server, and use its internal URL below. Leave `pixelburn-db` untouched and stopped-or-idle: rollback is pointing `DATABASE_URL` back at it.

The api and indexer run migrations on start. With `SOLANA_CLUSTER=mainnet-beta` both refuse to start on a database that holds another program's cursor, so the devnet database can't be mixed in by mistake.

The api's `/data` volume holds devnet uploads and the devnet `canvas.png`. `canvas.png` is re-rendered from the database on start. To be sure nothing devnet is served, give the api a new volume `/data` (keep the old one until launch is confirmed).

### Env per app (production and preview rows)

| App | Key | Value |
|---|---|---|
| api, indexer, keeper | `SOLANA_CLUSTER` | `mainnet-beta` |
| | `PROGRAM_ID` | `C44yH6k1btWPyRhyE3ub855RnCrBFgZqfjB8waFq7yu9` |
| | `TOKEN_MINT` | **delete it**: the devnet mint must not stay, and the mint now comes from Config |
| | `TOKEN_INITIAL_SUPPLY` | `1000000000000000` |
| | `SOLANA_RPC` | mainnet URL (secret, new on these apps) |
| | `SOLANA_RPC_HELIUS_KEY` | keep: it then points at Helius mainnet for websockets and history |
| api, indexer | `DATABASE_URL` | the new database (secret) |
| api | `IRYS_KEY` | base58 of `keys/mainnet/uploader.json` (secret; `--write-secrets`) |
| | `IRYS_NETWORK` | `mainnet` |
| | `ARWEAVE_GATEWAY` | `https://gateway.irys.xyz` |
| | `PUBLIC_API_URL_ALIASES` | can go: mainnet image URIs are `ar://` |
| keeper | `KEEPER_KEYPAIR` | `keys/mainnet/keeper.json` (secret; `--write-secrets`). Public key `EKVJrMEs…` |
| | `KEEPER_LOOKUP_TABLE` | from `node mainnet-env.ts` (the old value is a devnet table) |
| | `KEEPER_LIVE`, `KEEPER_BUYBACK_ENABLED` | `1`, `1` (preview rows: buybacks are `0`, keep them off) |
| | `KEEPER_BUYBACK_MIN_CHUNK_LAMPORTS` | `50000000` (now devnet-sized `5000000`) |
| | `KEEPER_BUYBACK_MAX_CHUNK_LAMPORTS` | `1000000000` (now `20000000`) |
| | `KEEPER_BUYBACK_MAX_PER_RUN_LAMPORTS` | `2000000000`, the on-chain hourly cap (now `20000000`) |
| | `KEEPER_BUYBACK_INTERVAL_MS`, `_JITTER_MS` | `900000`, `300000` (now `600000`, `120000`) |
| | `KEEPER_BUYBACK_MAX_SPOT_OVER_EMA_PCT` | `10` (now `12`; the on-chain backstop is 1.12x) |
| | `KEEPER_BUYBACK_MAX_PRICE_IMPACT_PCT`, `_MAX_RUN_PRICE_MOVE_PCT` | `1`, `5` (unchanged) |
| web | `NEXT_PUBLIC_SOLANA_CLUSTER` | `mainnet-beta`, **required and explicit: build-time**. The default is devnet. Needs the rebuild |
| | `SOLANA_RPC` | mainnet URL (secret, runtime, the upstream for `/api/rpc`) |

The keeper still has no `DATABASE_URL`. Apply with `python3 scripts/coolify.py PATCH /applications/<uuid>/envs <body file>`. The services refuse to start if `PROGRAM_ID` isn't the mainnet id or `IRYS_NETWORK` doesn't match, and a production api refuses a mainnet start without `IRYS_KEY`.

### Arweave uploads
The FAQ and landing page say images live on Arweave; the deployment uses local disk today. For mainnet `IRYS_KEY` is required:
- **Wallet:** `keys/mainnet/uploader.json`, dedicated, created by `mainnet-fund.ts`. Funded with **0.1 SOL** from the launch wallet.
- **Funding:** `services/src/uploads/storage.ts` funds on demand: when the Irys balance is below an upload's price it sends 1.2x the price from this wallet, one on-chain transaction per upload at worst.
- **Cost:** 2,424 lamports up to about 60 KB, 59,160 lamports at 2 MB (read 2026-11-05). All 10,000 blocks as small images cost about 0.025 SOL.
- **Limit of the design:** `POST /api/uploads` needs no payment, so anyone can spend this wallet, limited to 10 uploads a minute per IP. That's why it's a small dedicated wallet. When it runs dry, uploads fail and so do purchases. Alert below 0.02 SOL.
- **Gateway:** an upload is on `gateway.irys.xyz` at once but on `arweave.net` only later, and moderation fetches the image right after purchase. Hence `ARWEAVE_GATEWAY` above.
- **Domain:** on-chain image URIs become `ar://<id>`, so mainnet images stop depending on `api.pixelframe.tech`.

The Irys upload path has not been run against mainnet.

### Redeploy and check
Redeploy api, indexer, keeper, then web (about 3.5 min). Then:
- [ ] Site: empty canvas, "launching soon" banner, Buy shows "Opens at launch", no test-network label.
- [ ] api logs `cluster=mainnet-beta storage=irys`; `/healthz` ok; `/api/stats` zeros.
- [ ] indexer logs fallbacks `helius-mainnet…`, never a devnet label.
- [ ] keeper logs `mode=LIVE`, `pixel Config not found; waiting`, `using pinned lookup table`.

Devnet behaviour was kept up to this point: a devnet env still gets the devnet program, explorer links and label.

## 3. Launch day

Roles: owner launches on pump.fun with their own wallet; operator runs the scripts on the machine holding `keys/mainnet/launch.json`. That key never goes on a server.

**T-10 min.** Terminal 1, the graduation watcher. A curve can complete minutes after launch:
```sh
caffeinate -i node mainnet-graduation.ts watch --auto-execute --execute --mainnet-i-understand
```
It idles until a mint is recorded and Config exists.

**Owner, on pump.fun:** name `Pixel Frame`, symbol `PXL`, image `brand/token-image-1000.png`, website `https://pixelframe.tech`. Leave mayhem mode OFF and pair it with SOL: init refuses anything else. Send the mint to the operator.

**T0: mint received.** Terminal 2, paste carefully:
```sh
node mainnet-init.ts --mint <MINT> --execute --mainnet-i-understand
```

| Time | What happens | If not |
|---|---|---|
| T+1 s | Mint validated from chain | It refuses and nothing is sent. Check the mint with the owner. **Don't work around this: the mint is permanent** |
| T+1 to 61 s | Spot sampled. A wild market doesn't abort | Lower `--sample-secs` to go faster |
| T+65 s | `INITIALIZED`. Fees escalate and rebroadcast across both RPCs | It retries up to 6 blockhashes, then exits. Re-run the same command: safe |
| T+70 s | **Site flips by itself; SOL purchases open** | Reload once. Check `/api/rpc` on web |
| T+95 s | First crank (guard or keeper, at least 30 s after the seed) | Guard re-seeds on `EmaSeedMismatch` and retries every 30 s. It stops after 40. `node mainnet-guard.ts --execute --mainnet-i-understand` resumes |
| about T+11 min | Warm-up complete: token payments open | The site shows warming-up until then |

- Token payments and buybacks stay gated on-chain until warm-up. It's 10 cranks and 600 s from the first crank that passes the seed band, compile-time and not configurable. Each re-seed restarts it.
- If the curve already completed at T0, init seeds 0, SOL purchases still open, and the watcher does the switch.
- A seed taken in the first minutes can be far from where the price settles. Token buyers are charged `min(spot, fast EMA, slow EMA)`, so if the seed is low they pay more tokens for hours after a rally. If that matters, re-seed once the market has formed: `node mainnet-graduation.ts reseed --execute --mainnet-i-understand`. It restarts the warm-up.

**After T+2 min:**
```sh
node mainnet-verify.ts config
node mainnet-smoke.ts status
node mainnet-smoke.ts sol --x <x> --y <y> --image-uri <uri> --image-sha256 <hex> --execute --mainnet-i-understand   # optional, a real block, about $100
```
Token-payment smoke test, optional and after warm-up: `buy-tokens --sol <amount>` market-buys from the launch wallet (about +6.7% for 1 SOL on a fresh curve), then `token --x --y ...`.

```sh
node mainnet-registry.ts --execute --mainnet-i-understand     # verified build; the launch key signs the PDA directly
```

**Graduation** runs through terminal 1. Without the auto watcher: `node mainnet-graduation.ts watch` (no key) writes a proposal; review it, then `node mainnet-graduation.ts execute --execute --mainnet-i-understand` on the key machine. Token payments pause again for at least 10 minutes. SOL purchases are never affected.

## Keeper lookup table
`mainnet-keeper-alt.ts` creates it during step 1, so it's pinned from the first deploy and the "ACTION REQUIRED" flow never happens. The keeper never scans on mainnet.

## Rollback before the coin exists
Restore the env values, point `DATABASE_URL` back at `pixelburn-db`, set `NEXT_PUBLIC_SOLANA_CLUSTER=devnet`, rebuild web. The devnet program and rows are untouched. After initialize there's no rollback of the mint.

## Rehearsal timings
Run 2026-11-05 on devnet, one run: the real `--features mainnet` binary deployed at `C44y…`, a fresh pump coin, and a local api, indexer, keeper and web in the pre-launch state (`SOLANA_CLUSTER=mainnet-beta`, no mint, fresh database, devnet behind `RPC_URL`). A trader bought every 9 s through sampling, and both RPC endpoints went through a proxy that silently dropped the first 6 sends. A headless Chrome sat on `/canvas`.

| Step | Time after the mint was handed over |
|---|---|
| Mint validated | 1.1 s |
| 20 samples done, max/min 1.52, no abort; the seed took the latest reads (21.9% from the median) | 61.6 s |
| initialize simulated | 62.7 s |
| **Site flipped by itself in the open browser** | about 81 s |
| initialize confirmed by the script (it saw the landing after the rebroadcasts) | 82.4 s |
| Keeper adopted the mint, no restart | about 84 s |
| First crank failed `EmaSeedMismatch` (spot x1.303); guard re-seeded | about 123 s |
| First crank landed | 155.7 s |
| SOL purchase landed in 3.2 s; indexed by the api within a minute | about 145 s, see below |
| Earliest token payments, from the on-chain warm-up start | 12 min 34 s |

Limits of this run:
- Devnet confirmation is not mainnet confirmation under launch congestion. About 19 s of the initialize time is the dropped sends.
- The first SOL purchase attempt failed because of a script bug, since fixed. The second, at about 13:47:50, failed with a send error whose reason was hidden by rate-limited public-RPC retries. The third, through a different RPC, landed. I can't say SOL purchases worked from the moment of the flip.
- The web ran as `next dev`, not a production build. The real Docker build and the Coolify switch itself were not timed.
- The rehearsal used a 300 s `max_price_age`, because devnet's Pyth account can idle. Mainnet uses 120 s.
- No wallet signed through the site: the purchase came from the script, using the same SDK call as the site.

Not rehearsed: a blockhash expiring and the fee escalating, one RPC down, graduation within minutes (the watcher only idled), the Irys upload path, and anything on mainnet.
