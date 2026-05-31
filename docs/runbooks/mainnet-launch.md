# Mainnet Launch Runbook

## Pre-launch Checklist

- Database healthy
- Redis healthy
- Issuer wallet configured
- Distributor wallet configured
- Horizon endpoint verified
- JWT secrets configured

## Validation

GET /ops/mainnet-readiness

All checks must return PASS.

## Launch Steps

1. Deploy backend
2. Verify readiness endpoint
3. Verify health endpoint
4. Enable traffic

## Rollback

1. Revert deployment
2. Restart services
3. Verify readiness