import {
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc,
  xdr
} from "@stellar/stellar-sdk";
import { getEnv } from "../config/env.js";

export interface StellarConfig {
  horizonUrl: string;
  sorobanRpcUrl: string;
  networkPassphrase: string;
  contractId: string;
  simulatorAccount: string;
}

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

export class RpcError extends Error {
  constructor(message: string, public statusCode: number = 502) {
    super(message);
    this.name = "RpcError";
  }
}

export class RpcTimeoutError extends RpcError {
  constructor(message: string = "RPC operation timed out") {
    super(message, 504);
    this.name = "RpcTimeoutError";
  }
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  timeoutMs?: number;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  timeoutMs: 10000
};

export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries, initialDelayMs, timeoutMs } = {
    ...DEFAULT_RETRY_OPTIONS,
    ...options
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new RpcTimeoutError()), timeoutMs)
      );

      return await Promise.race([operation(), timeoutPromise]);
    } catch (error) {
      lastError = error as Error;

      // Don't retry validation errors or timeouts (unless we want to retry on timeout)
      if (error instanceof RequestValidationError) {
        throw error;
      }

      if (attempt < maxRetries) {
        const delay = initialDelayMs * Math.pow(2, attempt);
        console.warn(`[rpc] Attempt ${attempt + 1} failed, retrying in ${delay}ms...`, error);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new RpcError("RPC operation failed after retries");
}

let cachedConfig: StellarConfig | null = null;
let cachedRpcServer: rpc.Server | null = null;

export function loadStellarConfig(): StellarConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const env = getEnv();

  cachedConfig = {
    horizonUrl: env.HORIZON_URL,
    sorobanRpcUrl: env.SOROBAN_RPC_URL,
    networkPassphrase: env.SOROBAN_NETWORK_PASSPHRASE,
    contractId: env.CONTRACT_ID,
    simulatorAccount: env.SIMULATOR_ACCOUNT
  };

  return cachedConfig;
}

export function getStellarRpcServer(): rpc.Server {
  if (cachedRpcServer) {
    return cachedRpcServer;
  }

  const config = loadStellarConfig();
  cachedRpcServer = new rpc.Server(config.sorobanRpcUrl, { allowHttp: true });
  return cachedRpcServer;
}

/**
 * Fetch the Soroban account for the given address, or throw a
 * RequestValidationError with a role-specific message if it isn't found on
 * the currently configured network.
 */
export async function resolveSourceAccount(
  address: string,
  roleLabel = "source"
) {
  const server = getStellarRpcServer();
  try {
    // Don't retry: "account not found" isn't transient, and retrying would
    // blow past Express response timeouts on invalid addresses.
    return await server.getAccount(address);
  } catch {
    throw new RequestValidationError(
      `${roleLabel} account not found on selected network`
    );
  }
}

/**
 * Parse a Stellar address string into an Address object, or throw a
 * RequestValidationError naming the field that failed validation.
 */
export function parseStellarAddress(
  value: string,
  fieldLabel: string
): Address {
  try {
    return Address.fromString(value);
  } catch {
    throw new RequestValidationError(
      `${fieldLabel} must be a valid Stellar address`
    );
  }
}

/**
 * End-to-end primitive for building an unsigned contract-call transaction:
 * resolves the source account, assembles the contract invocation, prepares
 * the transaction, and shapes the response in the standard UnsignedTxResponse
 * form. New contract operations can be added by calling this with their
 * operation name + pre-built ScVal args.
 */
export async function buildUnsignedContractCall(params: {
  sourceAddress: string;
  sourceRoleLabel?: string;
  operation: string;
  args: xdr.ScVal[];
}): Promise<UnsignedTxResponse> {
  const config = loadStellarConfig();
  const server = getStellarRpcServer();

  const sourceAccount = await resolveSourceAccount(
    params.sourceAddress,
    params.sourceRoleLabel ?? "source"
  );

  const contract = new Contract(config.contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase
  })
    .addOperation(contract.call(params.operation, ...params.args))
    .setTimeout(300)
    .build();

  const preparedTx = await executeWithRetry(() => server.prepareTransaction(tx));

  return {
    xdr: preparedTx.toXDR(),
    metadata: {
      contractId: config.contractId,
      networkPassphrase: config.networkPassphrase,
      sourceAccount: params.sourceAddress,
      sequenceNumber: preparedTx.sequence,
      fee: preparedTx.fee,
      operation: params.operation
    }
  };
}