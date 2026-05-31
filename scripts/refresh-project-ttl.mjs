#!/usr/bin/env node
/**
 * TTL Refresh Operator Script for SplitNaira
 * 
 * This script calls the `refresh_project_storage` function on the SplitNaira contract
 * to extend TTL for project storage entries, preventing them from expiring.
 * 
 * Usage:
 *   # Refresh a single project
 *   node scripts/refresh-project-ttl.mjs --project-id "my_project"
 * 
 *   # Refresh multiple projects
 *   node scripts/refresh-project-ttl.mjs --project-id "project1" --project-id "project2"
 * 
 *   # Refresh all projects (use with caution on mainnet)
 *   node scripts/refresh-project-ttl.mjs --all
 * 
 *   # Dry run mode (simulate without submitting)
 *   node scripts/refresh-project-ttl.mjs --project-id "my_project" --dry-run
 * 
 * Environment Variables:
 *   SOROBAN_RPC_URL - Soroban RPC endpoint
 *   SOROBAN_NETWORK_PASSPHRASE - Network passphrase
 *   CONTRACT_ID - SplitNaira contract address
 *   OPERATOR_SECRET_KEY - Secret key for the operator account (required for actual execution)
 *   SIMULATOR_ACCOUNT - Account for simulation (optional, defaults to operator account)
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc
} from "@stellar/stellar-sdk";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

// Configuration
const config = {
  sorobanRpcUrl: process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.SOROBAN_NETWORK_PASSPHRASE || Networks.TESTNET,
  contractId: process.env.CONTRACT_ID,
  operatorSecretKey: process.env.OPERATOR_SECRET_KEY,
  simulatorAccount: process.env.SIMULATOR_ACCOUNT,
  maxRetries: 3,
  retryDelayMs: 2000,
  timeoutMs: 30000
};

// Validate required configuration
function validateConfig() {
  if (!config.contractId) {
    console.error("❌ CONTRACT_ID environment variable is required");
    process.exit(1);
  }

  try {
    Address.fromString(config.contractId);
  } catch (error) {
    console.error("❌ Invalid CONTRACT_ID format:", config.contractId);
    process.exit(1);
  }

  console.log("📋 Configuration:");
  console.log(`   RPC URL: ${config.sorobanRpcUrl}`);
  console.log(`   Network: ${config.networkPassphrase}`);
  console.log(`   Contract: ${config.contractId}`);
  console.log(`   Operator: ${config.operatorSecretKey ? "✓ Configured" : "❌ Not configured"}`);
  console.log("");
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    projectIds: [],
    all: false,
    dryRun: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === "--project-id" && i + 1 < args.length) {
      options.projectIds.push(args[++i]);
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      console.error(`❌ Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  return options;
}

// Show help message
function showHelp() {
  console.log(`
TTL Refresh Operator Script for SplitNaira

Usage:
  node scripts/refresh-project-ttl.mjs [options]

Options:
  --project-id <id>    Project ID to refresh (can be used multiple times)
  --all               Refresh all projects (use with caution)
  --dry-run           Simulate without submitting transactions
  --help, -h          Show this help message

Examples:
  # Refresh a single project
  node scripts/refresh-project-ttl.mjs --project-id "my_project"

  # Refresh multiple projects
  node scripts/refresh-project-ttl.mjs --project-id "project1" --project-id "project2"

  # Dry run for all projects
  node scripts/refresh-project-ttl.mjs --all --dry-run

Environment Variables:
  CONTRACT_ID              SplitNaira contract address (required)
  OPERATOR_SECRET_KEY      Secret key for operator account (required for execution)
  SOROBAN_RPC_URL         Soroban RPC endpoint (default: testnet)
  SOROBAN_NETWORK_PASSPHRASE  Network passphrase (default: testnet)
  SIMULATOR_ACCOUNT       Account for simulation (optional)
`);
}

// Initialize RPC server
function createRpcServer() {
  return new rpc.Server(config.sorobanRpcUrl, { allowHttp: true });
}

// Get operator keypair
function getOperatorKeypair() {
  if (!config.operatorSecretKey) {
    throw new Error("OPERATOR_SECRET_KEY is required for transaction execution");
  }
  
  try {
    return Keypair.fromSecret(config.operatorSecretKey);
  } catch (error) {
    throw new Error(`Invalid OPERATOR_SECRET_KEY: ${error.message}`);
  }
}

// Get simulator account
async function getSimulatorAccount(server) {
  const accountId = config.simulatorAccount || (config.operatorSecretKey ? getOperatorKeypair().publicKey() : null);
  
  if (!accountId) {
    throw new Error("Either SIMULATOR_ACCOUNT or OPERATOR_SECRET_KEY must be provided");
  }

  try {
    return await server.getAccount(accountId);
  } catch (error) {
    throw new Error(`Failed to load simulator account ${accountId}: ${error.message}`);
  }
}

// Retry wrapper for RPC operations
async function withRetry(operation, description) {
  let lastError;
  
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Operation timed out")), config.timeoutMs)
      );
      
      return await Promise.race([operation(), timeoutPromise]);
    } catch (error) {
      lastError = error;
      
      if (attempt < config.maxRetries) {
        console.log(`⚠️  ${description} failed (attempt ${attempt}/${config.maxRetries}): ${error.message}`);
        console.log(`   Retrying in ${config.retryDelayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, config.retryDelayMs));
      }
    }
  }
  
  throw new Error(`${description} failed after ${config.maxRetries} attempts: ${lastError.message}`);
}

// Get all project IDs from the contract
async function getAllProjectIds(server, sourceAccount) {
  console.log("🔍 Fetching all project IDs...");
  
  const contract = new Contract(config.contractId);
  const projectCount = await withRetry(async () => {
    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: config.networkPassphrase
    })
      .addOperation(contract.call("get_project_count"))
      .setTimeout(30)
      .build();

    const result = await server.simulateTransaction(tx);
    if (result.error) {
      throw new Error(`Contract simulation failed: ${result.error}`);
    }
    
    return result.result?.retval?.u32() || 0;
  }, "Get project count");

  console.log(`📊 Found ${projectCount} total projects`);

  if (projectCount === 0) {
    return [];
  }

  // Fetch project IDs in batches to avoid large responses
  const batchSize = 50;
  const allProjectIds = [];
  
  for (let offset = 0; offset < projectCount; offset += batchSize) {
    const limit = Math.min(batchSize, projectCount - offset);
    
    const projectIds = await withRetry(async () => {
      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: config.networkPassphrase
      })
        .addOperation(contract.call(
          "list_project_ids",
          nativeToScVal(offset, { type: "u32" }),
          nativeToScVal(limit, { type: "u32" })
        ))
        .setTimeout(30)
        .build();

      const result = await server.simulateTransaction(tx);
      if (result.error) {
        throw new Error(`Contract simulation failed: ${result.error}`);
      }
      
      // Parse the returned vector of symbols
      const retval = result.result?.retval;
      if (!retval) return [];
      
      const vec = retval.vec();
      return vec ? vec.map(item => item.sym().toString()) : [];
    }, `Get project IDs batch (offset: ${offset}, limit: ${limit})`);

    allProjectIds.push(...projectIds);
    console.log(`📋 Fetched ${projectIds.length} project IDs (${allProjectIds.length}/${projectCount})`);
  }

  return allProjectIds;
}

// Check if a project exists
async function projectExists(server, sourceAccount, projectId) {
  const contract = new Contract(config.contractId);
  
  try {
    const result = await withRetry(async () => {
      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: config.networkPassphrase
      })
        .addOperation(contract.call("project_exists", nativeToScVal(projectId, { type: "symbol" })))
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(tx);
      if (simResult.error) {
        throw new Error(`Contract simulation failed: ${simResult.error}`);
      }
      
      return simResult.result?.retval?.bool() || false;
    }, `Check project existence: ${projectId}`);

    return result;
  } catch (error) {
    console.warn(`⚠️  Could not check existence of project "${projectId}": ${error.message}`);
    return false;
  }
}

// Refresh TTL for a single project
async function refreshProjectTtl(server, sourceAccount, projectId, dryRun = false) {
  console.log(`🔄 ${dryRun ? "Simulating" : "Refreshing"} TTL for project: ${projectId}`);
  
  const contract = new Contract(config.contractId);
  
  // Build the transaction
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase
  })
    .addOperation(contract.call("refresh_project_storage", nativeToScVal(projectId, { type: "symbol" })))
    .setTimeout(30)
    .build();

  // Simulate the transaction
  const simResult = await withRetry(async () => {
    const result = await server.simulateTransaction(tx);
    if (result.error) {
      throw new Error(`Simulation failed: ${result.error}`);
    }
    return result;
  }, `Simulate TTL refresh for ${projectId}`);

  console.log(`   ✅ Simulation successful for project: ${projectId}`);
  
  if (dryRun) {
    console.log(`   🔍 Dry run - transaction would succeed`);
    return { success: true, txHash: null, dryRun: true };
  }

  // Execute the transaction
  if (!config.operatorSecretKey) {
    throw new Error("OPERATOR_SECRET_KEY is required for transaction execution");
  }

  const operatorKeypair = getOperatorKeypair();
  
  // Prepare and sign the transaction
  const preparedTx = await withRetry(async () => {
    return await server.prepareTransaction(tx);
  }, `Prepare transaction for ${projectId}`);

  preparedTx.sign(operatorKeypair);

  // Submit the transaction
  const submitResult = await withRetry(async () => {
    return await server.sendTransaction(preparedTx);
  }, `Submit transaction for ${projectId}`);

  if (submitResult.status === "ERROR") {
    throw new Error(`Transaction failed: ${submitResult.errorResult}`);
  }

  console.log(`   ✅ TTL refreshed for project: ${projectId}`);
  console.log(`   📝 Transaction hash: ${submitResult.hash}`);
  
  return { success: true, txHash: submitResult.hash, dryRun: false };
}

// Main execution function
async function main() {
  const options = parseArgs();
  
  if (options.help) {
    showHelp();
    return;
  }

  validateConfig();

  if (!options.all && options.projectIds.length === 0) {
    console.error("❌ Either --project-id or --all must be specified");
    console.log("   Use --help for usage information");
    process.exit(1);
  }

  if (options.dryRun) {
    console.log("🔍 Running in DRY RUN mode - no transactions will be submitted");
    console.log("");
  }

  const server = createRpcServer();
  
  // Test RPC connectivity
  console.log("🔗 Testing RPC connectivity...");
  const sourceAccount = await getSimulatorAccount(server);
  console.log(`✅ Connected to RPC, using account: ${sourceAccount.accountId()}`);
  console.log("");

  // Determine which projects to refresh
  let projectIds = options.projectIds;
  
  if (options.all) {
    console.log("🌍 Fetching all project IDs...");
    projectIds = await getAllProjectIds(server, sourceAccount);
    
    if (projectIds.length === 0) {
      console.log("ℹ️  No projects found in the contract");
      return;
    }
    
    console.log(`📋 Found ${projectIds.length} projects to refresh`);
    console.log("");
  } else {
    // Validate that specified projects exist
    console.log("🔍 Validating specified project IDs...");
    const validProjectIds = [];
    
    for (const projectId of projectIds) {
      const exists = await projectExists(server, sourceAccount, projectId);
      if (exists) {
        validProjectIds.push(projectId);
        console.log(`   ✅ Project exists: ${projectId}`);
      } else {
        console.log(`   ❌ Project not found: ${projectId}`);
      }
    }
    
    projectIds = validProjectIds;
    
    if (projectIds.length === 0) {
      console.error("❌ No valid projects found");
      process.exit(1);
    }
    
    console.log("");
  }

  // Refresh TTL for each project
  console.log(`🚀 Starting TTL refresh for ${projectIds.length} project(s)...`);
  console.log("");

  const results = {
    success: 0,
    failed: 0,
    errors: []
  };

  for (let i = 0; i < projectIds.length; i++) {
    const projectId = projectIds[i];
    console.log(`[${i + 1}/${projectIds.length}] Processing project: ${projectId}`);
    
    try {
      const result = await refreshProjectTtl(server, sourceAccount, projectId, options.dryRun);
      results.success++;
      
      if (!options.dryRun && result.txHash) {
        console.log(`   📝 Transaction: ${result.txHash}`);
      }
    } catch (error) {
      results.failed++;
      results.errors.push({ projectId, error: error.message });
      console.error(`   ❌ Failed: ${error.message}`);
    }
    
    console.log("");
  }

  // Summary
  console.log("📊 Summary:");
  console.log(`   ✅ Successful: ${results.success}`);
  console.log(`   ❌ Failed: ${results.failed}`);
  
  if (results.errors.length > 0) {
    console.log("");
    console.log("❌ Errors:");
    results.errors.forEach(({ projectId, error }) => {
      console.log(`   ${projectId}: ${error}`);
    });
  }

  if (results.failed > 0) {
    process.exit(1);
  }
}

// Handle errors and cleanup
process.on("unhandledRejection", (error) => {
  console.error("❌ Unhandled error:", error);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("\n🛑 Operation cancelled by user");
  process.exit(0);
});

// Run the script
main().catch((error) => {
  console.error("❌ Script failed:", error.message);
  process.exit(1);
});