## Reliability Improvements (Wave 5)

### Changes
- Added `requestTimeout` middleware to return 503 on slow requests
- Added unit tests for timeout middleware

### Rollback
Remove `requestTimeout` from `src/index.ts` middleware chain and delete `src/middleware/timeout.ts`.