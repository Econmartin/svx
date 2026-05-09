# Deploying SVX on Coolify

End-to-end walkthrough for getting SVX running on a self-hosted Coolify
instance, with both the bot and the dashboard publicly accessible.

## What you'll get

- Bot service (`svx-bot`) running 24/7, listening on port 4321 (read-only API).
- Dashboard service (`svx-dashboard`) on port 3030, public HTTPS via Coolify.
- Persistent SQLite ledger + `operator.json` in a Docker volume that survives redeploys.
- Auto-restart on crash; auto-redeploy on `git push` to the watched branch.

## One-time prep on your local machine

### 1. Push the repo

The repo is wired to `origin` (GitHub). If you haven't pushed yet:

```bash
cd /Users/martinswdev/Repos/SVX
git push -u origin main
```

### 2. Export your operator private key

Coolify needs the bech32 private key in an env var. Export it from your local
sui CLI keystore:

```bash
./scripts/export-operator-key.sh
# → suiprivkey1...
```

Copy that value — you'll paste it into Coolify in step 5 below. **Never commit it.**

### 3. Read your `operator.json` (only needed for live mode)

```bash
cat data/operator.json
# {
#   "operatorAddress": "0x73f4...",
#   "managerId": "0x02a1...",
#   ...
# }
```

Copy the entire JSON blob (single-line if you can; Coolify accepts multiline
secrets but single-line is safer). You'll paste it as the `OPERATOR_JSON` env
var in step 5.

## In Coolify

### 4. Create the application

1. Coolify dashboard → **Projects** → pick your project (or create new).
2. **+ Add Resource** → **Application** → source **Public** or **Private GitHub** depending on your repo visibility.
3. Repo: `https://github.com/Econmartin/svx`
4. Branch: `main`
5. **Build Pack**: **Docker Compose**
6. **Docker Compose Location**: `docker-compose.yml` (the default).
7. Save → don't deploy yet.

### 5. Set env vars

In the application's **Environment Variables** tab, add:

| Variable | Value | Type |
|----------|-------|------|
| `SUI_PRIVATE_KEY_BECH32` | `suiprivkey1…` from step 2 | **Secret** |
| `OPERATOR_JSON` | the JSON from step 3 | **Secret** (live mode only) |
| `PAPER_TRADING` | `true` (start safe) or `false` (live) | Build & Runtime |
| `MAX_POSITION_DUSDC` | `0.5` | Build & Runtime |
| `DAILY_LOSS_LIMIT_DUSDC` | `5` | Build & Runtime |
| `SPREAD_THRESHOLD` | `0.03` | Build & Runtime |
| `EXPIRY_TOLERANCE_SEC` | `3600` | Build & Runtime |

For live trading you can leave the rest at their compose defaults.

### 6. Public domains

Coolify reads the `SERVICE_FQDN_*` env names in the compose file and offers
to generate domains automatically.

- **Dashboard** → assign `svx.<your-domain>` (or accept the auto-generated `*.coolify.<your-domain>`).
- **Bot API** → assign `svx-api.<your-domain>` (or accept the auto-generated one).

Once you have the bot's public FQDN, add it as a build-time env var so the
dashboard's client bundle knows where to fetch from:

| Variable | Value |
|----------|-------|
| `NEXT_PUBLIC_SVX_API` | `https://svx-api.<your-domain>` |

### 7. Deploy

Hit **Deploy**. Coolify clones, runs `docker compose build`, then `docker
compose up -d`. First build takes ~3–5 minutes; subsequent builds are
incremental (~30s if dependencies don't change).

### 8. Verify

```bash
curl https://svx-api.<your-domain>/health        # → {"ok":true,...}
curl https://svx-api.<your-domain>/status        # → bot status JSON
open https://svx.<your-domain>                    # dashboard
```

The dashboard should show the live status badge, NAV, surface viewer for
active oracles, and the signal stream as it captures.

## Updating

After local code changes:

```bash
git add -A && git commit -m "..." && git push
```

Coolify auto-deploys on push (if the webhook is enabled — it is by default
for GitHub apps).

## Operations on the deployed instance

```bash
# Coolify CLI: tail logs
coolify logs --app svx --follow

# Or via the Coolify UI: Application → Logs tab.
```

To pause trading without redeploying:
```bash
# Connect to the running container via Coolify's terminal:
touch /tmp/svx-paused
```

To switch between paper and live without rebuilding:
1. Update `PAPER_TRADING` env var in Coolify
2. Click **Restart** on the application

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Build fails on `pnpm install` | Lockfile out of sync | `pnpm install` locally, commit `pnpm-lock.yaml`, push |
| Bot logs `addressesPinned: false` | Coolify env override blanked the package ID | Remove the `PREDICT_PACKAGE_ID` env var to fall back to baked default |
| Dashboard "Could not reach SVX API" | `NEXT_PUBLIC_SVX_API` not set or wrong | Set it to the bot's public FQDN; trigger a rebuild (it's baked in at build time) |
| `Live trading enabled but no operator record` | `OPERATOR_JSON` not set or `PAPER_TRADING=false` without it | Set `OPERATOR_JSON` env var, then restart |
| Volume disappears on redeploy | Volume name changed | Use the named volume `svx-data` (already in compose) — Coolify preserves named volumes across redeploys |

## Securing the public bot API

The bot's API is read-only but it does proxy to public services and consumes
modest CPU per request. For production:

- Coolify's built-in Traefik handles HTTPS termination automatically.
- Rate-limit at the Traefik layer if you anticipate abuse: add a `traefik.http.middlewares.svx-rl.ratelimit.average=10` label to the bot service in `docker-compose.yml`.
- The `/oracles` endpoint is the heaviest (full indexer pull). Consider rate-limiting it specifically.

## Mainnet swap

When DeepBook Predict ships on mainnet:
1. Update `packages/svx-shared/src/addresses.ts` with mainnet IDs (or set the env vars in Coolify).
2. Switch the operator key to a hardware-wallet-backed one (do NOT use the same key on mainnet that you used on testnet — testnet keys may have leaked through screenshots/logs).
3. Set `SUI_NETWORK=mainnet` and `SUI_RPC_URL=https://fullnode.mainnet.sui.io:443` in Coolify.
4. Set `MAX_POSITION_DUSDC` to your initial capital ramp value (recommend $50 for the first 3 days; see [mainnet-runbook.md](mainnet-runbook.md)).
5. Trigger a rebuild.
