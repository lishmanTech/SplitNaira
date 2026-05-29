## CI/CD Reliability Improvements (Wave 5)

### Changes
- Added `.github/workflows/dependency-audit.yml`: weekly automated `npm audit` for high-severity vulnerabilities
- Added `scripts/healthcheck.mjs`: deployment readiness probe that verifies backend `/health/live`

### Rollback
- Delete `.github/workflows/dependency-audit.yml` to stop scheduled audits
- Remove `scripts/healthcheck.mjs` from deployment pipeline

### Operational Notes
- Audit workflow runs every Monday at 06:00 UTC and can be triggered manually
- Healthcheck script exits with 503 if backend is unreachable — safe to use as a pre-deploy gate