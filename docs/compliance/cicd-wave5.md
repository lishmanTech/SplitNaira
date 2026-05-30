# CI/CD Compliance - Wave 5

## Objective
Deliver production-grade CI/CD compliance improvements for SplitNaira.

## Implementation Plan

### 1. Pipeline Hardening
- All jobs use pinned action versions (actions/checkout@v4, actions/setup-node@v6)
- Permissions scoped to minimum required (contents: read)
- Secrets never echoed in logs

### 2. Build Reproducibility
- npm ci used instead of npm install for deterministic installs
- Node version pinned to 20 across all jobs
- Rust toolchain pinned via dtolnay/rust-toolchain@stable

### 3. Test Gates
- All PRs must pass: data-integrity, frontend lint+build+test, backend lint+build+test, contracts fmt+test+build
- continue-on-error not used on required checks

### 4. Deployment Safety
- Testnet deploy only triggers on main branch push
- No production deploy without passing CI
- Rollback: revert commit and push to main triggers redeploy

## Rollback Notes
CI config changes take effect immediately on next push. Revert this PR to restore previous pipeline.

## Operational Impact
No changes to application code. Pipeline improvements only.
