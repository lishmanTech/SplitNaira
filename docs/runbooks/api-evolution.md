# API Evolution Runbook

> **Scope:** Frontend API client evolution — typed error handling, smart retry
> policy, response mapping compatibility, and deploy-safe change procedures.
> Covers the `ApiClient` class in `frontend/src/lib/api-client.ts`.

---

## Overview

The frontend communicates with the SplitNaira backend exclusively through
`ApiClient`. API evolution changes (new endpoints, response shape changes,
error contract updates) must preserve backward compatibility and keep the
onboarding and split management flows uninterrupted.

---

## ApiError — Typed Error Classification

All non-2xx responses now throw `ApiError` instead of a plain `Error`.
Consumers can branch on typed helpers rather than parsing message strings.

```typescript
import { ApiError } from "@/lib/api";

try {
  await client.getSplit(projectId);
} catch (err) {
  if (err instanceof ApiError) {
    if (err.isNotFound)      { /* show "project not found" UI */ }
    if (err.isUnauthorized)  { /* prompt wallet reconnect */ }
    if (err.isServerError)   { /* show retry banner */ }
    console.log(err.code);   // e.g. "project_exists", "validation_error"
  }
}
```

### ApiError Properties

| Property | Type | Description |
|----------|------|-------------|
| `status` | `number` | HTTP status code |
| `message` | `string` | Human-readable message (from server body or fallback) |
| `code` | `string \| undefined` | Machine-readable error code from `error` or `code` field |
| `isClientError` | `boolean` | `status >= 400 && status < 500` |
| `isServerError` | `boolean` | `status >= 500` |
| `isNotFound` | `boolean` | `status === 404` |
| `isUnauthorized` | `boolean` | `status === 401 \|\| status === 403` |

---

## Smart Retry Policy

`ApiClient` uses `withRetry` with a `shouldRetry` predicate to avoid
retrying errors that will never succeed:

| Error type | Retried? | Rationale |
|------------|----------|-----------|
| Network failure / timeout | ✅ Yes (3×) | Transient — worth retrying |
| 5xx Server Error | ✅ Yes (3×) | Server-side transient failure |
| 429 Too Many Requests | ✅ Yes (3×) | Rate limit — back off and retry |
| 4xx Client Error (400, 401, 403, 404, 422…) | ❌ No | Bad request — retrying won't help |

This prevents unnecessary load on the backend and faster error surfacing to
the user for client errors.

---

## Sentry Observability

`ApiError` instances are captured with enriched tags:

```
section:    "api-client"
path:       "/splits/admin/status"
httpStatus: "400"
errorCode:  "validation_error"
```

This allows filtering Sentry issues by HTTP status or backend error code
without parsing message strings.

---

## Response Mapping Compatibility

`mapProjectToCamelCase` in `api-client.ts` handles both camelCase and
snake_case field names from the backend. This ensures the frontend remains
functional during a backend field-naming migration:

```typescript
projectId:          p.projectId ?? p.project_id
projectType:        p.projectType ?? p.project_type
totalDistributed:   p.totalDistributed ?? p.total_distributed
distributionRound:  p.distributionRound ?? p.distribution_round
collaborators[].basisPoints: c.basisPoints ?? c.basis_points
```

**When removing snake_case support:** coordinate with the backend team,
verify the backend has shipped camelCase responses to production, then
remove the fallback in a separate PR.

---

## Adding a New API Endpoint

1. Add the method to `ApiClient` in `api-client.ts`.
2. Export a convenience function from `api.ts`.
3. Add a test in `frontend/src/__tests__/api-evolution.test.ts` covering:
   - Happy path response mapping
   - Error body parsing (4xx with `message` + `error` fields)
   - Retry behaviour (does it retry on 5xx? does it not retry on 4xx?)
4. Run `npm run test -w frontend` and `npm run build -w frontend`.

---

## Changing an Existing Response Shape

| Change type | Safe? | Action required |
|-------------|-------|-----------------|
| Add optional field | ✅ Yes | No frontend change needed |
| Rename field | ⚠️ Breaking | Add fallback in `mapProjectToCamelCase`; remove after backend ships |
| Remove field | ⚠️ Breaking | Add `?? defaultValue` guard in mapping; coordinate deploy order |
| Change field type | ❌ Breaking | Requires coordinated backend + frontend deploy |

---

## Deploy Safety

### Pre-deploy Checklist

- [ ] `npm run test -w frontend` passes (including `api-evolution.test.ts`)
- [ ] `npm run build -w frontend` passes
- [ ] `npm run lint -w frontend` passes with zero warnings
- [ ] New `ApiError` usages in components handle `isNotFound` and `isServerError`
- [ ] No `process.env` reads bypassing `getEnv()` introduced

### Rollback

If an API evolution change breaks the frontend:

1. Revert the frontend deploy (Vercel / Render → previous deployment).
2. If the backend shipped a breaking response change simultaneously, revert
   the backend deploy first (see [Mainnet Launch Runbook](./mainnet-launch.md)).
3. Verify the split list loads: `GET /splits` returns projects and the
   Projects tab renders without errors.

### Operational Impact

| Change | Downtime | Risk |
|--------|----------|------|
| Add `ApiError` classification | None | Low — additive only |
| Smart retry predicate | None | Low — reduces unnecessary retries |
| Response field rename with fallback | None | Low — dual-read during transition |
| Remove snake_case fallback | None | Medium — coordinate with backend |

---

## Related

- [Frontend Deployment Runbook](./frontend-deployment.md)
- [Frontend Release Ops](./frontend-release-ops.md)
- [Observability Runbook](./observability.md)
- [User Onboarding Runbook](./user-onboarding.md)
