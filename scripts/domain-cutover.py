#!/usr/bin/env python3
"""Move the site to a new domain. Dry run by default; only --apply changes anything.

Usage:
    python3 scripts/domain-cutover.py pixelframe.tech                  # dry run: prints exactly what would change
    python3 scripts/domain-cutover.py pixelframe.tech --apply          # patches Coolify and redeploys api + web
    python3 scripts/domain-cutover.py pixelframe.tech --verify         # read-only HTTP checks after the deploys
Options:
    --old-host redirect|keep   what the old web host does (default redirect, needs the rebuild this script triggers)
    --no-deploy                with --apply: patch config, deploy later yourself
    --skip-dns-check           with --apply: go ahead even though DNS doesn't point at the server yet

Reads and writes through scripts/coolify.py, which takes request bodies from a file path. Coolify env responses hold
secrets: they stay in this process, and only the keys in MANAGED are ever printed. Runbook: docs/domain-cutover.md
"""
import argparse
import json
import re
import socket
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

COOLIFY = str(Path(__file__).resolve().parent / "coolify.py")
SERVER_IP = "94.16.31.213"
WEB = "bmo4kdaoxkyzvjmrxenootrr"
API = "xvlz2veeyem2wmwl2wp7yiwt"
OLD_WEB_HOST = "pixelburn.applicure.io"
OLD_API_HOST = "api.pixelburn.applicure.io"
# The only env keys this script reads values of, writes or prints. None of them is secret.
MANAGED = {"NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_SITE_URL", "LEGACY_SITE_HOSTS", "PUBLIC_API_URL", "PUBLIC_API_URL_ALIASES", "CORS_ORIGINS"}


def coolify(method, path, body=None):
    """Runs scripts/coolify.py and returns parsed JSON. Output is captured, so nothing secret reaches the terminal."""
    cmd = [sys.executable, "-B", COOLIFY, method, path]
    if body is None:
        run = subprocess.run(cmd, capture_output=True, text=True)
    else:
        with tempfile.NamedTemporaryFile("w", suffix=".json") as f:
            json.dump(body, f)
            f.flush()
            run = subprocess.run(cmd + [f.name], capture_output=True, text=True)
    if run.returncode != 0:
        # coolify.py redacts its token from errors, but an error body could echo a value: print the status line only
        first = (run.stderr.strip().splitlines() or ["no output"])[-1]
        raise SystemExit(f"coolify {method} {path} failed: {first[:200]}")
    return json.loads(run.stdout)


def valid_domain(d):
    return re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}", d) is not None


def targets(domain, old_host):
    site, www, api = f"https://{domain}", f"https://www.{domain}", f"https://api.{domain}"
    old_site, old_api = f"https://{OLD_WEB_HOST}", f"https://{OLD_API_HOST}"
    return {
        WEB: {
            "label": "web (pixelburn-web)",
            # the old host stays on the router in both modes: without it Traefik would 404 it before Next could redirect
            "domains": [site, www, old_site],
            "redirect": "non-www",
            "env": {
                "NEXT_PUBLIC_API_URL": api,
                "NEXT_PUBLIC_SITE_URL": site,
                "LEGACY_SITE_HOSTS": OLD_WEB_HOST if old_host == "redirect" else "",
            },
        },
        API: {
            "label": "api (pixelburn-api)",
            # the old API host stays: on-chain image_uri values and tabs opened before the move name it
            "domains": [api, old_api],
            "redirect": None,
            "env": {
                "PUBLIC_API_URL": api,
                "PUBLIC_API_URL_ALIASES": old_api,
                "CORS_ORIGINS": ",".join([site, www, old_site]),
            },
        },
    }


def plan_app(uuid, want):
    """Compares live Coolify config with the target. Returns (patch body or None, env ops)."""
    app = coolify("GET", f"/applications/{uuid}")
    live_domains = [d.strip() for d in (app.get("fqdn") or "").split(",") if d.strip()]
    patch = {}
    if set(live_domains) != set(want["domains"]):
        patch["domains"] = ",".join(want["domains"])
    if want["redirect"] and app.get("redirect") != want["redirect"]:
        patch["redirect"] = want["redirect"]

    envs = [e for e in coolify("GET", f"/applications/{uuid}/envs") if e.get("key") in MANAGED]
    ops = []
    for key, value in want["env"].items():
        # Coolify keeps a production and a preview row per key; keep them in step
        for preview in (False, True):
            row = next((e for e in envs if e["key"] == key and bool(e.get("is_preview")) == preview), None)
            if row is None:
                if value:
                    ops.append(("create", key, value, preview, None))
            elif row.get("value") != value:
                ops.append(("update", key, value, preview, row.get("value")))
    return app, live_domains, patch, ops


def dns_status(domain):
    out = {}
    for host in (domain, f"www.{domain}", f"api.{domain}"):
        try:
            ips = sorted({r[4][0] for r in socket.getaddrinfo(host, 443, socket.AF_INET)})
        except socket.gaierror:
            ips = []
        out[host] = ips
    return out


def print_dns(status):
    ok = True
    print("DNS (A records must point at the server, or Let's Encrypt can't issue certificates)")
    for host, ips in status.items():
        good = ips == [SERVER_IP]
        ok = ok and good
        print(f"  {'ok     ' if good else 'MISSING' if not ips else 'WRONG  '} {host:<32} {', '.join(ips) or 'no A record'}  (want {SERVER_IP})")
    return ok


def http_get(url, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": "domain-cutover", **(headers or {})})

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=20) as r:
            return r.status, dict(r.headers), r.read(2_000_000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), ""
    except Exception as e:  # DNS, TLS, timeouts: all just mean the check failed
        return 0, {}, str(e)[:120]


def verify(domain, old_host):
    site, api, old_site, old_api = f"https://{domain}", f"https://api.{domain}", f"https://{OLD_WEB_HOST}", f"https://{OLD_API_HOST}"
    fails = 0

    def check(name, ok, detail=""):
        nonlocal fails
        fails += 0 if ok else 1
        print(f"  {'ok  ' if ok else 'FAIL'} {name}{'  ' + detail if detail else ''}")

    print("Verify (read-only)")
    s, _, html = http_get(site + "/")
    check(f"{site}/ answers 200", s == 200, f"status {s}")
    m = re.search(r'property="og:image" content="([^"]+)"', html)
    check("og:image is absolute on the new domain", bool(m) and m.group(1).startswith(site + "/"), m.group(1) if m else "not found")
    _, h, _ = http_get(site + "/")
    check("CSP allows the new API (web was rebuilt)", f"api.{domain}" in h.get("Content-Security-Policy", ""), "")
    s, h, _ = http_get(f"https://www.{domain}/")
    check("www redirects to the apex", s in (301, 302, 307, 308) and h.get("Location", "").startswith(site), f"status {s} {h.get('Location', '')}")
    s, h, _ = http_get(old_site + "/canvas?x=1")
    if old_host == "redirect":
        check("old host redirects, keeping path and query", s in (307, 308) and h.get("Location", "") == site + "/canvas?x=1", f"status {s} {h.get('Location', '')}")
    else:
        check("old host still serves", s == 200, f"status {s}")
    s, _, _ = http_get(api + "/health")
    check(f"{api}/health", s == 200, f"status {s}")
    s, _, _ = http_get(old_api + "/health")
    check(f"{old_api}/health (old host kept)", s == 200, f"status {s}")
    s, h, _ = http_get(api + "/api/stats", {"Origin": site})
    check("CORS allows the new origin", h.get("Access-Control-Allow-Origin") == site, h.get("Access-Control-Allow-Origin", "no header"))
    s, h, _ = http_get(api + "/api/stats", {"Origin": old_site})
    check("CORS still allows the old origin", h.get("Access-Control-Allow-Origin") == old_site, h.get("Access-Control-Allow-Origin", "no header"))
    s, _, body = http_get(api + "/api/ads")
    try:
        ads = json.loads(body)
    except ValueError:
        ads = None
    check("/api/ads answers", isinstance(ads, list), f"status {s}")
    for ad in ads or []:
        url = ad.get("imageUrl", "")
        stale = OLD_API_HOST in url
        check(f"ad {ad.get('id')} image not on the old host", not stale, url[:70] + ("  PUBLIC_API_URL_ALIASES not active" if stale else ""))
        if url.startswith("http"):
            si, _, _ = http_get(url)
            check(f"ad {ad.get('id')} image loads", si == 200, f"status {si}")
    print(f"{fails} check(s) failed" if fails else "All checks passed")
    return fails


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("domain")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--no-deploy", action="store_true")
    ap.add_argument("--skip-dns-check", action="store_true")
    ap.add_argument("--old-host", choices=["redirect", "keep"], default="redirect")
    args = ap.parse_args()
    domain = args.domain.strip().lower()
    if not valid_domain(domain):
        raise SystemExit(f"Not a bare domain: {args.domain!r} (want e.g. pixelframe.tech, no scheme, no www)")
    if args.apply and args.verify:
        raise SystemExit("--apply and --verify are separate steps.")
    if args.verify:
        raise SystemExit(1 if verify(domain, args.old_host) else 0)

    print(f"Domain cutover to {domain}  [{'APPLY' if args.apply else 'DRY RUN, nothing will change'}]\n")
    status = dns_status(domain)
    dns_ok = print_dns(status)
    print()

    plans = []
    for uuid, want in targets(domain, args.old_host).items():
        app, live, patch, ops = plan_app(uuid, want)
        plans.append((uuid, want, patch, ops))
        print(f"{want['label']}  {uuid}")
        print(f"  live domains   {', '.join(live) or '(none)'}   redirect={app.get('redirect')}")
        if patch:
            print(f"  PATCH /applications/{uuid}")
            print(f"    {json.dumps(patch)}")
        else:
            print("  domains        no change")
        for op, key, value, preview, old in ops:
            row = "preview" if preview else "production"
            verb = f"POST  /applications/{uuid}/envs" if op == "create" else f"PATCH /applications/{uuid}/envs"
            print(f"  {verb}  {key} [{row}]")
            print(f"    {old!r} -> {value!r}" if op == "update" else f"    (new) {value!r}")
        if not ops:
            print("  env            no change")
        changed = bool(patch or ops)
        print(f"  deploy         {'POST /deploy?uuid=' + uuid if changed and not args.no_deploy else 'skipped'}")
        print()

    print("Left alone: indexer and keeper have no domain and no env naming one.")
    print("Build-time: NEXT_PUBLIC_* are baked into the web image, so the web env only takes effect with the rebuild.")
    if not dns_ok:
        print(f"\nDNS is not ready. Add the missing A records (-> {SERVER_IP}) before applying; Traefik can't get certificates without them.")

    if not args.apply:
        print("\nDry run. Nothing was changed. Re-run with --apply to do this.")
        return
    if not dns_ok and not args.skip_dns_check:
        raise SystemExit("\nRefusing to apply: DNS is not ready. Use --skip-dns-check to override.")
    if not any(p[2] or p[3] for p in plans):
        print("\nNothing to do.")
        return

    # the API goes first: its old host keeps answering throughout, and the new web build needs the new API host
    for uuid, want, patch, ops in sorted(plans, key=lambda p: p[0] != API):
        print(f"\nApplying {want['label']}")
        if patch:
            coolify("PATCH", f"/applications/{uuid}", patch)
            print("  domains patched")
        for op, key, value, preview, _ in ops:
            if op == "create":
                # Coolify's POST creates the production and preview rows together, so the second create would 409
                rows = coolify("GET", f"/applications/{uuid}/envs")
                if any(e["key"] == key and bool(e.get("is_preview")) == preview and e.get("value") == value for e in rows):
                    print(f"  exists {key} [{'preview' if preview else 'production'}]")
                    continue
            body = {"key": key, "value": value, "is_preview": preview, "is_literal": False}
            coolify("POST" if op == "create" else "PATCH", f"/applications/{uuid}/envs", body)
            print(f"  {op} {key} [{'preview' if preview else 'production'}]")
        if uuid == WEB:
            # NEXT_PUBLIC_* do nothing unless they reach the build: don't spend a deploy finding that out
            rows = coolify("GET", f"/applications/{uuid}/envs")
            bad = [e["key"] for e in rows if e.get("key") in want["env"] and want["env"][e["key"]] and not e.get("is_buildtime")]
            if bad:
                raise SystemExit(f"  Not build-time in Coolify: {sorted(set(bad))}. Tick 'Available at Buildtime' for them, then deploy web.")
        if (patch or ops) and not args.no_deploy:
            coolify("POST", f"/deploy?uuid={uuid}")
            print("  deploy queued")
    print(f"\nWhen both deploys are healthy: python3 scripts/domain-cutover.py {domain} --verify")


if __name__ == "__main__":
    main()
