# TTL Refresh Operations Runbook

## Overview

This runbook covers Time-To-Live (TTL) refresh operations for the SplitNaira smart contract. Soroban contracts use TTL to manage storage lifecycle, and inactive projects may need manual TTL extension to prevent storage expiration.

## Background

### What is TTL in Soroban?

Time-To-Live (TTL) is Soroban's mechanism for managing contract storage lifecycle:

- **Persistent Storage**: Used for project data, has configurable TTL
- **Automatic Extension**: Hot paths (create, distribute, claim) automatically extend TTL
- **Manual Extension**: Inactive projects may need operator intervention
- **Storage Eviction**: Expired entries are removed from the ledger

### SplitNaira TTL Configuration

```rust
// From contracts/lib.rs
const PROJECT_TTL_THRESHOLD_LEDGERS: u32 = 50_000;  // ~7 days
const PROJECT_TTL_BUMP_LEDGERS: u32 = 100_000;      // ~14 days
```

### Automatic TTL Extension

The contract automatically extends TTL on these operations:
- `create_project` - New project creation
- `lock_project` - Project locking
- `deposit` - Funds deposit
- `distribute` - Revenue distribution
- `get_project` - Project data access
- `get_claimed` - Claimed amount queries
- `update_metadata` - Metadata updates
- `transfer_ownership` - Ownership transfers

### Manual TTL Extension

The `refresh_project_storage` function allows operators to manually extend TTL:

```rust
pub fn refresh_project_storage(env: Env, project_id: Symbol) -> Result<(), SplitError>
```

This function:
- ✅ Is permissionless (any account can call it)
- ✅ Extends TTL for project data and collaborator claims
- ✅ Returns error if project doesn't exist
- ✅ Is safe to call repeatedly

## When to Refresh TTL

### Scenarios Requiring TTL Refresh

1. **Long-term Inactive Projects**
   - Projects with no activity for weeks/months
   - Important historical projects that should be preserved
   - Projects awaiting future distributions

2. **Pre-emptive Maintenance**
   - Before major network upgrades
   - During maintenance windows
   - As part of regular operational procedures

3. **Recovery Operations**
   - After identifying projects near expiration
   - Following monitoring alerts
   - During incident response

### Monitoring TTL Status

Currently, TTL monitoring requires:
- Custom tooling to query ledger state
- Soroban RPC calls to check storage entries
- Proactive monitoring of project activity

**Future Enhancement**: Consider implementing TTL monitoring dashboards and alerts.

## TTL Refresh Script

### Script Location

```bash
scripts/refresh-project-ttl.mjs
```

### Prerequisites

1. **Node.js Environment**
   ```bash
   node --version  # Requires Node.js 18+
   ```

2. **Environment Configuration**
   ```bash
   # Required
   export CONTRACT_ID="CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
   export OPERATOR_SECRET_KEY="SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
   
   # Optional (defaults to testnet)
   export SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
   export SOROBAN_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
   export SIMULATOR_ACCOUNT="GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
   ```

3. **Account Requirements**
   - Operator account must have sufficient XLM for transaction fees
   - Account must be funded and active on the target network

### Usage Examples

#### Single Project Refresh

```bash
# Refresh TTL for a specific project
node scripts/refresh-project-ttl.mjs --project-id "my_music_project"
```

#### Multiple Projects

```bash
# Refresh multiple projects
node scripts/refresh-project-ttl.mjs \
  --project-id "project_1" \
  --project-id "project_2" \
  --project-id "project_3"
```

#### All Projects (Use with Caution)

```bash
# Refresh all projects (expensive on mainnet)
node scripts/refresh-project-ttl.mjs --all
```

#### Dry Run Mode

```bash
# Simulate without executing transactions
node scripts/refresh-project-ttl.mjs --project-id "test_project" --dry-run
```

### Script Features

- ✅ **Validation**: Checks project existence before refresh
- ✅ **Retry Logic**: Handles temporary RPC failures
- ✅ **Batch Processing**: Efficiently handles multiple projects
- ✅ **Dry Run Mode**: Safe testing without transaction costs
- ✅ **Error Handling**: Detailed error reporting and recovery
- ✅ **Progress Tracking**: Real-time progress for large operations

## Operational Procedures

### Routine Maintenance

**Frequency**: Monthly or as needed

1. **Identify Candidates**
   ```bash
   # Get list of all projects
   node scripts/refresh-project-ttl.mjs --all --dry-run
   ```

2. **Prioritize Projects**
   - Focus on high-value or historically important projects
   - Consider projects with recent but not current activity
   - Skip projects with regular ongoing activity

3. **Execute Refresh**
   ```bash
   # Refresh selected projects
   node scripts/refresh-project-ttl.mjs \
     --project-id "important_project_1" \
     --project-id "legacy_project_2"
   ```

### Emergency Response

**Scenario**: Critical project near expiration

1. **Immediate Action**
   ```bash
   # Emergency refresh for critical project
   node scripts/refresh-project-ttl.mjs --project-id "critical_project"
   ```

2. **Verification**
   ```bash
   # Verify refresh was successful
   node scripts/refresh-project-ttl.mjs --project-id "critical_project" --dry-run
   ```

3. **Documentation**
   - Log the incident and response
   - Update monitoring if applicable
   - Review prevention measures

### Bulk Operations

**Scenario**: Refresh all projects (e.g., before network upgrade)

1. **Pre-flight Checks**
   ```bash
   # Estimate scope and cost
   node scripts/refresh-project-ttl.mjs --all --dry-run
   ```

2. **Staged Execution**
   ```bash
   # Execute in smaller batches to manage costs and monitor progress
   # Batch 1: First 50 projects
   node scripts/refresh-project-ttl.mjs --project-id "proj1" --project-id "proj2" ...
   
   # Batch 2: Next 50 projects
   # ... continue as needed
   ```

3. **Monitoring**
   - Monitor transaction success rates
   - Watch for RPC rate limits or failures
   - Track total costs and timing

## Cost Considerations

### Transaction Fees

- **Per Project**: ~0.00001 XLM (1 stroop) base fee
- **Network Fees**: May vary based on network congestion
- **Bulk Operations**: Costs scale linearly with project count

### Example Costs

```
Single Project:    ~0.00001 XLM
10 Projects:       ~0.0001 XLM  
100 Projects:      ~0.001 XLM
1000 Projects:     ~0.01 XLM
```

### Cost Optimization

1. **Selective Refresh**: Only refresh projects that need it
2. **Batch Operations**: Use script's batch processing
3. **Timing**: Execute during low-congestion periods
4. **Monitoring**: Track costs and set budgets

## Troubleshooting

### Common Issues

#### 1. Project Not Found

```
❌ Project not found: my_project
```

**Causes**:
- Project ID typo or case sensitivity
- Project was never created
- Project ID format mismatch

**Resolution**:
```bash
# Verify project exists
node scripts/refresh-project-ttl.mjs --project-id "correct_project_id" --dry-run
```

#### 2. RPC Connection Failures

```
❌ RPC operation failed after retries
```

**Causes**:
- Network connectivity issues
- RPC endpoint overload
- Invalid RPC URL configuration

**Resolution**:
1. Check network connectivity
2. Verify RPC URL configuration
3. Try alternative RPC endpoints
4. Wait and retry during off-peak hours

#### 3. Insufficient Account Balance

```
❌ Transaction failed: insufficient balance
```

**Causes**:
- Operator account lacks XLM for fees
- Account not properly funded

**Resolution**:
```bash
# Check account balance
stellar account --account-id GXXXXXXX...

# Fund account if needed
stellar account fund GXXXXXXX...
```

#### 4. Invalid Secret Key

```
❌ Invalid OPERATOR_SECRET_KEY
```

**Causes**:
- Malformed secret key
- Wrong key format
- Key for different network

**Resolution**:
1. Verify secret key format (starts with 'S')
2. Ensure key matches target network
3. Check for typos or truncation

### Recovery Procedures

#### Failed Batch Operation

1. **Identify Failed Projects**
   - Review script output for specific failures
   - Note which projects succeeded vs. failed

2. **Retry Failed Projects**
   ```bash
   # Retry only the failed projects
   node scripts/refresh-project-ttl.mjs \
     --project-id "failed_project_1" \
     --project-id "failed_project_2"
   ```

3. **Investigate Root Cause**
   - Check RPC logs for patterns
   - Verify network conditions
   - Review account status

## Security Considerations

### Access Control

- **Permissionless Function**: Anyone can call `refresh_project_storage`
- **No Privilege Escalation**: Function only extends TTL, cannot modify data
- **Safe Operation**: Cannot harm projects or steal funds

### Operational Security

1. **Secret Key Management**
   - Store operator keys securely
   - Use environment variables, not hardcoded keys
   - Rotate keys periodically

2. **Network Verification**
   - Always verify target network (testnet vs mainnet)
   - Double-check contract addresses
   - Use dry-run mode for testing

3. **Transaction Monitoring**
   - Monitor all transactions for success
   - Keep logs of operations
   - Set up alerts for failures

## Monitoring and Alerting

### Recommended Monitoring

1. **Project Activity Tracking**
   - Monitor projects with no recent activity
   - Track time since last TTL extension
   - Alert on projects approaching expiration

2. **Script Execution Monitoring**
   - Log all TTL refresh operations
   - Monitor success/failure rates
   - Track operational costs

3. **Network Health**
   - Monitor RPC endpoint availability
   - Track transaction confirmation times
   - Alert on network congestion

### Future Enhancements

1. **Automated TTL Monitoring**
   - Dashboard showing project TTL status
   - Automated alerts for projects near expiration
   - Integration with existing monitoring systems

2. **Smart Refresh Scheduling**
   - Automated refresh based on activity patterns
   - Cost-optimized batch scheduling
   - Integration with CI/CD pipelines

3. **Enhanced Reporting**
   - TTL refresh history and analytics
   - Cost tracking and budgeting
   - Performance metrics and optimization

## Related Documentation

- [Contract Release and Upgrade Runbook](./contract-release-and-upgrade-runbook.md)
- [Observability Runbook](./observability.md)
- [Reliability Runbook](./reliability.md)
- [SplitNaira Contract Documentation](../contracts/README.md)

## Changelog

| Date | Version | Changes |
|------|---------|---------|
| 2024-12-01 | 1.0.0 | Initial TTL refresh runbook and script |

---

**⚠️ Important**: Always test TTL refresh operations on testnet before executing on mainnet. The `refresh_project_storage` function is safe but transaction fees are real costs.