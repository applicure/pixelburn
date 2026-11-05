# Deployment

The site is Pixel Frame (formerly The Million Pixel Burn). Infrastructure names keep `pixelburn`: see `brand/README.md`. The move to pixelframe.tech is prepared but not run: `docs/domain-cutover.md`.

Same infrastructure as `pumpswap-pools` (Juice): Coolify on srv1, Traefik + Let's Encrypt, `*.applicure.io` wildcard DNS → 94.16.31.213.

| | |
|---|---|
| Site | https://pixelburn.applicure.io (live); https://pixelframe.tech after the cutover |
| API | https://api.pixelburn.applicure.io (live); https://api.pixelframe.tech after the cutover |
| Coolify dashboard | https://coolify.applicure.io → **pixelburn → production** |
| Coolify project | `pixelburn` — `uasdgghhvaeprxcqqaztubhd` |
| Database | `pixelburn-db` — `72ukjfjrfpmftkq88r0hhwqe`, `postgres:17-alpine`, DB/user `pixelburn`, internal only, 512 MB / 1 CPU |
| Server | `srv1` — server_uuid `lp3fhhehppsxe0w0r2g5nva7`, destination `afyohn7u6ur6gs7m6a7ik94q` |

Planned apps (created once the code passes review and a private GitHub repo exists):

| App | Build | Domain |
|---|---|---|
| `pixelburn-web` | `apps/web/Dockerfile` (Next standalone, port 3000) | pixelburn.applicure.io |
| `pixelburn-api` | `services/Dockerfile` target `api` (port 8080) | api.pixelburn.applicure.io |
| `pixelburn-indexer` | `services/Dockerfile` target `indexer` | — |
| `pixelburn-keeper` | `services/Dockerfile` target `keeper`, dry-run unless `KEEPER_LIVE=1` | — |

## Secrets

Live only in the gitignored `.env` (copied from pumpswap-pools) and as Coolify runtime env — never in the repo or a `NEXT_PUBLIC_*` var:
`COOLIFY_TOKEN`, `SOLANA_RPC` (QuickNode, mainnet), `SOLANA_RPC_HELIUS_KEY`, `SOLANA_RPC_HELIUS_KEY_2`, `COOLIFY_DATABASE_URL_INTERNAL`.

Note: the QuickNode endpoint is mainnet. While the program runs on devnet, services use Helius devnet (`https://devnet.helius-rpc.com/?api-key=…`).

```sh
python3 scripts/coolify.py GET /projects/uasdgghhvaeprxcqqaztubhd
python3 scripts/coolify.py POST '/deploy?uuid=<app uuid>'
```
