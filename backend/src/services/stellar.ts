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

/**
 * Shape returned by every unsigned-transaction builder — what the client
 * receives to sign with Freighter and submit back to the network.
 */
export interface UnsignedTxResponse {
  xdr: string;
  metadata: {
    contractId: string;
    networkPassphrase: string;
    sourceAccount: string;
    sequenceNumber: string;
    fee: string;
    operation: string;
  };
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
 * Detect whether an error from `server.getAccount(...)` actually means the
 * account doesn't exist, versus a transient RPC/network failure we should
 * surface as a 5xx. Checks common shapes: HTTP 404 status codes, numeric
 * `code`/`status` fields, and "not found" in the error message.
 */
function isAccountNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as {
    code?: number | string;
    status?: number;
    message?: string;
    response?: { status?: number };
  };

  const message = maybeError.message?.toLowerCase() ?? "";

  return (
    maybeError.code === 404 ||
    maybeError.status === 404 ||
    maybeError.response?.status === 404 ||
    /not[\s_-]?found/.test(message)
  );
}

/**
 * Fetch the Soroban account for the given address. Only translates genuine
 * "not found" errors into RequestValidationError (→ 400). Other errors
 * (timeouts, RPC failures) propagate up so middleware can surface them as
 * 5xx instead of misleading 400s.
 *
 * Wrapped in executeWithRetry with maxRetries: 0 to keep the timeout race
 * without retrying — account-not-found isn't transient, and retrying would
 * blow past Express response timeouts on invalid addresses.
 */
export async function resolveSourceAccount(
  address: string,
  roleLabel = "source"
) {
  const server = getStellarRpcServer();
  try {
    return await executeWithRetry(() => server.getAccount(address), {
      maxRetries: 0
    });
  } catch (error) {
    if (isAccountNotFoundError(error)) {
      throw new RequestValidationError(
        `${roleLabel} account not found on selected network`
      );
    }
    throw error;
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