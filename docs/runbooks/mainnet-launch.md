# Mainnet Launch Runbook

> **Scope:** Production deployment of the SplitNaira backend to mainnet.
> Covers pre-launch validation, deploy steps, smoke testing, and rollback.

---

## Pre-launch Checklist

Run through every item before triggering `mainnet-deploy.yml`.

| # | Check | Command / Verification |
|---|-------|------------------------|
| 1 | Database healthy | `GET /health/ready` → `components.db.ok: true` |
| 2 | Redis healthy | `GET /health/ready` → all components ok |
| 3 | Issuer wallet configured | `STELLAR_ISSUER_PUBLIC_KEY` set and passes `G[A-Z0-9]{55}` regex |
| 4 | Distributor wallet configured | `STELLAR_DISTRIBUTOR_PUBLIC_KEY` set and passes regex |
| 5 | Horizon endpoint verified | `HORIZON_URL` points to `https://horizon.stellar.org` |
| 6 | JWT secrets configured | `JWT_SECRET` present in production environment |
| 7 | `MAINNET_CONTRACT_ID` secret set | GitHub → Settings → Secrets → `MAINNET_CONTRACT_ID` |
| 8 | `RENDER_BACKEND_DEPLOY_HOOK_URL` set | GitHub → Settings → Secrets |
| 9 | All CI checks green on `main` | CI workflow must have passed before triggering |
| 10 | `npm run verify:data-integrity` passes | Run locally or check last CI run |
| 11 | Database migrations applied | `npm run migration:run -w backend` |

---

## Validation

### Mainnet Readiness Endpoint

```bash
GET /ops/mainnet-readiness
```

All four checks must return `"status": "pass"`:

```json
{
  "ready": true,
  "timestamp": "2026-01-01T00:00:00.000Z",
  "checks": [
    { "name": "environment",     "status": "pass" },
    { "name": "stellar-network", "status": "pass" },
    { "name": "wallet-config",   "status": "pass" },
    { "name": "database",        "status": "pass" }
  ]
}
```

If any check returns `"fail"`, **do not proceed** until the issue is resolved.

### Health Endpoints

```bash
GET /health/live    # → { "status": "ok" }
GET /health/ready   # → { "status": "ready", "components": { ... } }
GET /health/startup # → { "status": "started" }
```

---

## CI/CD Pipeline — `mainnet-deploy.yml`

The workflow enforces a strict gate sequence:

```
validate-mainnet-config
  └─► verify-backend-mainnet   (lint + build + test)
        └─► mainnet-readiness-gate   (polls /ops/mainnet-readiness)
              └─► deploy-mainnet   (triggers Render hook)
                    └─► post-deploy-smoke   (polls /health/ready)
                          └─► notify-on-failure   (prints rollback steps on failure)
```

**Key safety properties:**
- `cancel-in-progress: false` — an in-flight mainnet deploy is never cancelled by a concurrent run.
- Required secrets (`MAINNET_CONTRACT_ID`, `RENDER_BACKEND_DEPLOY_HOOK_URL`) are asserted before any deploy step runs.
- The `production` GitHub environment gate requires manual approval if configured.

### Triggering a Deploy

1. Navigate to **Actions → Mainnet Deploy → Run workflow**.
2. Leave `deploy_target` as `render` (default) unless overriding.
3. Leave `deploy_environment` as `production`.
4. Click **Run workflow**.

---

## Launch Steps

1. Confirm all pre-launch checklist items are complete.
2. Trigger `mainnet-deploy.yml` via GitHub Actions UI.
3. Monitor the `validate-mainnet-config` job — it will fail fast if secrets are missing.
4. Monitor `verify-backend-mainnet` — lint, build, and tests must pass.
5. Monitor `mainnet-readiness-gate` — polls `/ops/mainnet-readiness` up to 10 times.
6. Monitor `deploy-mainnet` — Render deploy hook is triggered.
7. Monitor `post-deploy-smoke` — polls `/health/ready` for up to 5 minutes.
8. Confirm all jobs are green before announcing availability.

---

## Rollback

### Fast Rollback (< 5 minutes)

1. **Identify the last stable deploy** in the Render dashboard (Services → splitnaira-backend → Deploys).
2. Click **Rollback** on the last known-good deploy in Render, or re-trigger the previous deploy hook.
3. Verify recovery:
   ```bash
   curl https://api.splitnaira.com/health/ready
   curl https://api.splitnaira.com/ops/mainnet-readiness
   ```
4. Confirm all four readiness checks return `"pass"`.

### Database Migration Rollback

If a migration caused the failure:

```bash
npm run migration:revert -w backend
```

Then redeploy the previous backend version.

### Contract Emergency Pause

If the on-chain contract is misbehaving:

1. Call `pause_distributions` using the admin wallet.
2. Communicate the pause to users via status page.
3. Investigate before calling `unpause_distributions`.

### Full Revert

1. Revert the git commit that changed contract ID configs.
2. Re-run deploy pipelines for backend and frontend only.
3. **Do not delete old contract IDs on-chain** — funds may remain there.

---

## Operational Impact

| Step | Downtime | Data Risk |
|------|----------|-----------|
| Backend redeploy | Brief restart (~30s) | None if DB unchanged |
| DB migration | None (online migration) | Low — always test on staging first |
| Contract deploy (new ID) | None until cutover | Old contract remains on-chain |
| Pause distributions | Distribute blocked | Deposits safe |

---

## Monitoring After Launch

- **Health dashboard:** `GET /health/ready` — check `components` for any degraded service.
- **Mainnet readiness:** `GET /ops/mainnet-readiness` — all checks must remain `pass`.
- **Logs:** Structured JSON logs via `winston`; filter by `level: "error"` for anomalies.
- **Sentry:** Monitor for new error spikes in the `production` environment.
- **Horizon / Soroban RPC latency:** Watch configured endpoints for elevated response times.

---

## Related Runbooks

- [Ops Deployment & Rollback](./ops-deployment-rollback.md)
- [CI/CD Data Integrity](./ci-data-integrity.md)
- [Reliability](./reliability.md)
- [Observability](./observability.md)
