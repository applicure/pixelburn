# Domain cutover: pixelframe.tech

Moves the site from `pixelburn.applicure.io` to **pixelframe.tech**, with the API at **api.pixelframe.tech**. Prepared, not run.

```sh
python3 scripts/domain-cutover.py pixelframe.tech            # dry run: prints exactly what would change
python3 scripts/domain-cutover.py pixelframe.tech --apply    # patches Coolify, redeploys api then web
python3 scripts/domain-cutover.py pixelframe.tech --verify   # read-only checks once both deploys are healthy
```

The script compares against live Coolify config, so a second run only does what is left. It prints only the env keys it manages (none is secret). It refuses `--apply` while DNS is wrong, unless you pass `--skip-dns-check`.

## 1. DNS

| Type | Name | Value | Status (2026-11-05) |
|---|---|---|---|
| A | `@` (pixelframe.tech) | `94.16.31.213` | done |
| A | `www` | `94.16.31.213` | done |
| A | `api` | `94.16.31.213` | **missing: add it first** |
| MX | `@` | the mail provider's records | **check**: `team@pixelframe.tech` is the published security contact, so it must receive mail |

Don't proxy these (no CDN "orange cloud") until the certificates are issued: Traefik gets them from Let's Encrypt over HTTP on this server.

## 2. Ship the code first

`--apply` only works properly on a build that contains this rebrand. The services need `PUBLIC_API_URL_ALIASES`, and the web needs `NEXT_PUBLIC_SITE_URL` and `LEGACY_SITE_HOSTS`. So push `main` and let the apps deploy first, or at least in the same session.

Until the cutover, a build with this code has `metadataBase` on `https://pixelframe.tech` (the default), while nothing routes that host yet. Social previews of the old host show broken images in that window, so keep it short.

## 3. Run it

Dry-run, read the output, then `--apply`. What it changes:

| App | Setting | Now | After |
|---|---|---|---|
| web `bmo4kdaoxkyzvjmrxenootrr` | domains | `https://pixelburn.applicure.io` | `https://pixelframe.tech,https://www.pixelframe.tech,https://pixelburn.applicure.io` |
| | redirect | `both` | `non-www` (www goes to the apex) |
| | `NEXT_PUBLIC_API_URL` (build) | `https://api.pixelburn.applicure.io` | `https://api.pixelframe.tech` |
| | `NEXT_PUBLIC_SITE_URL` (build, new) | | `https://pixelframe.tech` |
| | `LEGACY_SITE_HOSTS` (build, new) | | `pixelburn.applicure.io` |
| api `xvlz2veeyem2wmwl2wp7yiwt` | domains | `https://api.pixelburn.applicure.io` | `https://api.pixelframe.tech,https://api.pixelburn.applicure.io` |
| | `PUBLIC_API_URL` | `https://api.pixelburn.applicure.io` | `https://api.pixelframe.tech` |
| | `PUBLIC_API_URL_ALIASES` (new) | | `https://api.pixelburn.applicure.io` |
| | `CORS_ORIGINS` | `https://pixelburn.applicure.io` | `https://pixelframe.tech,https://www.pixelframe.tech,https://pixelburn.applicure.io` |

Production and preview rows change together. The indexer and keeper have no domain and no env naming one, so they stay as they are.

`NEXT_PUBLIC_*` are baked in at build time, so **the web needs a rebuild**; the script triggers it. Coolify's API has no documented flag for "build-time" on new env rows and defaults them on. The script reads them back and stops before deploying web if they came out runtime-only.

The container labels are generated (`is_container_label_readonly_enabled` is true on both apps), so the domain patch reaches Traefik on the next deploy.

### The old web host

- `--old-host redirect` (default): the old host stays on the router so it gets a certificate, and Next answers it with a temporary redirect to the same path on the new domain (`next.config.ts`). `/api/*`, `/_next/*` and `/healthz` are not redirected, so tabs opened before the move keep working until their next navigation.
- `--old-host keep`: the old host keeps serving the site as it is.

To make the redirect permanent later, change `permanent` in `next.config.ts`.

## 4. Why the old API host stays: stored image URLs

**Without `PUBLIC_API_URL_ALIASES`, changing `PUBLIC_API_URL` breaks every existing ad on this deployment.**

- The API runs without `IRYS_KEY`, so uploads use local storage: `image_uri` is `${PUBLIC_API_URL}/files/<sha256>.png`, and that full URL is written **on-chain** and into `ads.image_uri` at purchase. Both live ads point at `api.pixelburn.applicure.io`. Only the ad's owner can change it, with `update_ad`.
- The old code only rewrites a stored URL to the current API if its origin is the current `PUBLIC_API_URL` or localhost. After the move, an old URL would go out unchanged. Then:
  1. the browser is blocked by the web's CSP, whose `img-src` lists only the new API origin, so the ad is blank;
  2. the composer and moderation fail with `image host not allowed`, because the SSRF allow-list only has the new host. `canvas.png` drops any image not already in its cache.
- The fix: origins in `PUBLIC_API_URL_ALIASES` count as this API. Old URIs are rewritten to the new host and read from `/data/files`. Tested in `services/test/redact.test.ts`.
- The old API host also stays routed, because the on-chain URIs and anything reading them directly still name it. **Keep it while any ad's on-chain URI names it.**

Arweave `ar://` URIs depend on no domain. Mainnet should use Irys (`IRYS_KEY`) for that reason: a local-storage URI is a domain tied to the chain forever. The site's FAQ already says images are on Arweave, which is not yet true of this deployment.

## 5. Verify

```sh
python3 scripts/domain-cutover.py pixelframe.tech --verify
```

It checks the site, the absolute `og:image`, www and old-host redirects, both API hosts, CORS for both origins, and that every ad image loads from the new host. Then by hand: connect a wallet, and paste the URL into a social preview tool. Previews cache, so old cards take time to refresh.

## 6. After the move, by hand

- **Program `security_txt`** (`chain/programs/pixel/src/lib.rs`): the source has `project_url` `https://pixelframe.tech`, `policy` `https://pixelframe.tech/security`, `contacts` `email:team@pixelframe.tech`, name `Pixel Frame (pixel)`. **Not deployed**: it goes out with the batched program upgrade. Still a placeholder: `source_code` `https://github.com/applicure/pixelburn` (a private repo) and an empty `source_release`. Confirm these before the verified mainnet build.
- **Helius webhook**, if one is registered: point it at `https://api.pixelframe.tech/webhooks/helius`. The old host keeps working meanwhile.
- `apps/web/scripts/livetest.mjs`: run with `SITE=` and `API=`, or update its defaults, which still name the old hosts.
- `docs/deployment.md`: drop the "after the cutover" wording.
- HSTS: the site sends `includeSubDomains; preload`, so once a browser sees pixelframe.tech, every subdomain must have HTTPS. That includes anything added later, such as a mail or docs host.

## Rollback

The old hosts never stop routing, so run the same patches back: domains and envs to the "Now" column above, then redeploy both apps. `PUBLIC_API_URL_ALIASES` and `LEGACY_SITE_HOSTS` are harmless if emptied. The redirect is temporary (307), so browsers won't have cached it.
