import { Request, Response, NextFunction, Router } from "express";
import { z } from "zod";
import { CollaboratorSchema } from "../generated/contract-types.js";
import {
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr
} from "@stellar/stellar-sdk";

import {
  loadStellarConfig,
  getStellarRpcServer,
  RequestValidationError,
  executeWithRetry,
  getCached,
  setCached,
  invalidateCache,
  invalidateCacheByPrefix,
  getCacheStats,
  READ_CACHE_TTL_MS,
  type UnsignedTxResponse
} from "../services/stellar.js";

import { 
  AppError, 
  ErrorCode, 
  ErrorType, 
  translateSorobanError 
} from "../lib/errors.js";

function serializeBigInts(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "bigint") return obj.toString();
  if (Array.isArray(obj)) return obj.map(serializeBigInts);
  if (typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, serializeBigInts(v)])
    );
  }
  return obj;
}

export const splitsRouter = Router();

// Strict Stellar address validator used across schemas
export const stellarAddressSchema = z
  .string()
  .min(1, "address is required")
  .superRefine((value, ctx) => {
    try {
      Address.fromString(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be a valid Stellar address (classic or contract)"
      });
    }
  });

export const collaboratorSchema = CollaboratorSchema.extend({
  address: stellarAddressSchema,
  basisPoints: z
    .number()
    .int("basisPoints must be an integer")
    .positive("basisPoints must be greater than 0")
    .max(10_000, "basisPoints must be <= 10000")
});

export const createSplitSchema = z
  .object({
    owner: stellarAddressSchema.describe("owner"),
    projectId: z
      .string()
      .min(1, "projectId is required")
      .max(32)
      .regex(/^[a-zA-Z0-9_]+$/, "projectId must be alphanumeric/underscore"),
    title: z.string().min(1, "title is required").max(128),
    projectType: z.string().min(1, "projectType is required").max(32),
    token: stellarAddressSchema.describe("token"),
    collaborators: z.array(collaboratorSchema).min(2, "at least 2 collaborators are required")
  })
  .superRefine((payload, ctx) => {
    const totalBasisPoints = payload.collaborators.reduce(
      (sum, collaborator) => sum + collaborator.basisPoints,
      0
    );
    if (totalBasisPoints !== 10_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["collaborators"],
        message: "collaborators basisPoints must sum to exactly 10000"
      });
    }

    const addresses = new Set<string>();
    for (const collaborator of payload.collaborators) {
      if (addresses.has(collaborator.address)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["collaborators"],
          message: "duplicate collaborator address found"
        });
        break;
      }
      addresses.add(collaborator.address);
    }
  });

export const projectIdParamSchema = z
  .string()
  .min(1, "projectId is required")
  .max(32, "projectId must be at most 32 characters")
  .regex(/^[a-zA-Z0-9_]+$/, "projectId must be alphanumeric/underscore");

export const lockProjectSchema = z.object({
  owner: stellarAddressSchema.describe("owner")
});

export const depositSchema = z.object({
  from: stellarAddressSchema.describe("from"),
  amount: z
    .number()
    .positive("amount must be greater than 0")
    .describe("deposit amount in stroops")
});

export const updateMetadataSchema = z.object({
  owner: stellarAddressSchema.describe("owner"),
  title: z.string().min(1, "title is required").max(128),
  projectType: z.string().min(1, "projectType is required").max(32)
});

export const updateCollaboratorsSchema = z
  .object({
    owner: stellarAddressSchema.describe("owner"),
    collaborators: z.array(collaboratorSchema).min(2, "at least 2 collaborators are required")
  })
  .superRefine((payload, ctx) => {
    const totalBasisPoints = payload.collaborators.reduce(
      (sum, collaborator) => sum + collaborator.basisPoints,
      0
    );
    if (totalBasisPoints !== 10_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["collaborators"],
        message: "collaborators basisPoints must sum to exactly 10000"
      });
    }

    const addresses = new Set<string>();
    for (const collaborator of payload.collaborators) {
      if (addresses.has(collaborator.address)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["collaborators"],
          message: "duplicate collaborator address found"
        });
        break;
      }
      addresses.add(collaborator.address);
    }
  });

const allowlistQuerySchema = z.object({
  start: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100)
});

export function toCollaboratorScVal(collaborator: z.infer<typeof collaboratorSchema>) {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal("address", { type: "symbol" }),
      val: Address.fromString(collaborator.address).toScVal()
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("alias", { type: "symbol" }),
      val: nativeToScVal(collaborator.alias)
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("basis_points", { type: "symbol" }),
      val: xdr.ScVal.scvU32(collaborator.basisPoints)
    })
  ]);
}

export function buildCreateProjectContractArgs(
  input: z.infer<typeof createSplitSchema>
): xdr.ScVal[] {
  const ownerAddress = Address.fromString(input.owner);
  const tokenAddress = Address.fromString(input.token);
  const collaboratorScVals = input.collaborators.map((collaborator) =>
    toCollaboratorScVal(collaborator)
  );

  return [
    ownerAddress.toScVal(),
    nativeToScVal(input.projectId, { type: "symbol" }),
    nativeToScVal(input.title),
    nativeToScVal(input.projectType),
    tokenAddress.toScVal(),
    xdr.ScVal.scvVec(collaboratorScVals)
  ];
}

export function buildUpdateCollaboratorsContractArgs(
  input: UpdateCollaboratorsRequest
): xdr.ScVal[] {
  const ownerAddress = Address.fromString(input.owner);
  const collaboratorScVals = input.collaborators.map((collaborator) =>
    toCollaboratorScVal(collaborator)
  );

  return [
    nativeToScVal(input.projectId, { type: "symbol" }),
    ownerAddress.toScVal(),
    xdr.ScVal.scvVec(collaboratorScVals)
  ];
}

export function buildLockProjectContractArgs(input: LockProjectRequest): xdr.ScVal[] {
  const ownerAddress = Address.fromString(input.owner);
  return [
    nativeToScVal(input.projectId, { type: "symbol" }),
    ownerAddress.toScVal()
  ];
}

export function buildDepositContractArgs(input: DepositRequest): xdr.ScVal[] {
  const fromAddress = Address.fromString(input.from);
  return [
    nativeToScVal(input.projectId, { type: "symbol" }),
    fromAddress.toScVal(),
    nativeToScVal(input.amount, { type: "i128" })
  ];
}

export function buildAdminTokenContractArgs(input: AdminTokenRequest): xdr.ScVal[] {
  const adminAddress = Address.fromString(input.admin);
  const tokenAddress = Address.fromString(input.token);
  return [adminAddress.toScVal(), tokenAddress.toScVal()];
}

function parseStellarAddress(address: string, label: string): Address {
  try {
    return Address.fromString(address);
  } catch {
    throw new RequestValidationError(`${label} must be a valid Stellar address`);
  }
}

async function buildUnsignedContractCall(input: {
  sourceAddress: string;
  sourceRoleLabel: string;
  operation: string;
  args: xdr.ScVal[];
}): Promise<UnsignedTxResponse> {
  const config = loadStellarConfig();
  const server = getStellarRpcServer();

  let sourceAccount;
  try {
    sourceAccount = await executeWithRetry(() => server.getAccount(input.sourceAddress));
  } catch {
    throw new RequestValidationError(`${input.sourceRoleLabel} account not found on selected network`);
  }

  const contract = new Contract(config.contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase
  })
    .addOperation(contract.call(input.operation, ...input.args))
    .setTimeout(300)
    .build();

  const preparedTx = await executeWithRetry(() => server.prepareTransaction(tx));

  return {
    xdr: preparedTx.toXDR(),
    metadata: {
      contractId: config.contractId,
      networkPassphrase: config.networkPassphrase,
      sourceAccount: input.sourceAddress,
      sequenceNumber: preparedTx.sequence,
      fee: preparedTx.fee,
      operation: input.operation
    }
  };
}

export function buildHistoryTopicFilters(projectId: string) {
  const encodeSymbolTopic = (value: string) => {
    const scVal = nativeToScVal(value, { type: "symbol" }) as unknown as {
      toXDR?: (format: "base64") => string;
    };
    if (typeof scVal?.toXDR === "function") {
      return scVal.toXDR("base64");
    }
    return String(value);
  };

  const topicProjectId = encodeSymbolTopic(projectId);
  const roundTopic = encodeSymbolTopic("distribution_complete");
  const paymentTopic = encodeSymbolTopic("payment_sent");
  return { topicProjectId, roundTopic, paymentTopic };
}

export function decodeRoundHistoryEventValue(value: xdr.ScVal) {
  const data = scValToNative(value) as [number | bigint, string | number | bigint];
  return {
    round: Number(data[0]),
    amount: String(data[1])
  };
}

export function decodePaymentHistoryEventValue(value: xdr.ScVal) {
  const data = scValToNative(value) as [string, string | number | bigint];
  return {
    recipient: data[0],
    amount: String(data[1])
  };
}

async function buildCreateProjectUnsignedXdr(
  input: z.infer<typeof createSplitSchema>
) {
  const config = loadStellarConfig();
  const server = getStellarRpcServer();

  let sourceAccount;
  try {
    sourceAccount = await executeWithRetry(() => server.getAccount(input.owner));
  } catch {
    throw new RequestValidationError("owner account not found on selected network");
  }

  let args: xdr.ScVal[];
  try {
    args = buildCreateProjectContractArgs(input);
  } catch {
    throw new RequestValidationError("owner/token/collaborator addresses must be valid Stellar addresses");
  }

  const contract = new Contract(config.contractId);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase
  })
    .addOperation(
      contract.call("create_project", ...args)
    )
    .setTimeout(300)
    .build();

  const preparedTx = await executeWithRetry(() => server.prepareTransaction(tx));

  return {
    xdr: preparedTx.toXDR(),
    metadata: {
      contractId: config.contractId,
      networkPassphrase: config.networkPassphrase,
      sourceAccount: input.owner,
      sequenceNumber: preparedTx.sequence,
      fee: preparedTx.fee,
      operation: "create_project"
    }
  };
}

async function simulateReadOnlyContractCall(
  method: string,
  args: xdr.ScVal[] = []
) {
  const config = loadStellarConfig();
  const server = getStellarRpcServer();

  let sourceAccount;
  try {
    sourceAccount = await server.getAccount(config.simulatorAccount);
  } catch {
    throw new RequestValidationError("simulator account not found on selected network");
  }

  const contract = new Contract(config.contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(300)
    .build();

  const simulated = await server.simulateTransaction(tx);
  return "result" in simulated ? simulated.result?.retval : undefined;
}

async function fetchProjectsFromContract(start: number, limit: number) {
  const cacheKey = `list_projects:${start}:${limit}`;
  const cached = getCached<unknown[]>(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const config = loadStellarConfig();
  const server = getStellarRpcServer();

  let sourceAccount;
  try {
    sourceAccount = await executeWithRetry(() => server.getAccount(config.simulatorAccount));
  } catch {
    throw new RequestValidationError("simulator account not found on selected network");
  }

  const contract = new Contract(config.contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase
  })
    .addOperation(
      contract.call("list_projects", xdr.ScVal.scvU32(start), xdr.ScVal.scvU32(limit))
    )
    .setTimeout(300)
    .build();

  const simulated = await executeWithRetry(() => server.simulateTransaction(tx));
  const retval = "result" in simulated ? simulated.result?.retval : undefined;
  if (!retval) {
    return [];
  }

  const result = scValToNative(retval) as unknown[];
  setCached(cacheKey, result);
  return result;
}

async function listProjects(
  start: number,
  limit: number,
  search?: string,
  type?: string,
) {
  if (!search && !type) {
    return fetchProjectsFromContract(start, limit);
  }

  const maxFetch = 1000;
  const allProjects = await fetchProjectsFromContract(0, maxFetch);

  let filtered: unknown[] = allProjects;
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter((p: Record<string, unknown>) =>
      String(p.title ?? "").toLowerCase().includes(q) ||
      String(p.projectId ?? "").toLowerCase().includes(q)
    );
  }
  if (type) {
    const t = type.toLowerCase();
    filtered = filtered.filter((p: Record<string, unknown>) =>
      String(p.projectType ?? "").toLowerCase() === t
    );
  }

  return filtered.slice(start, start + limit);
}

async function fetchProjectById(projectId: string) {
  const cacheKey = `project:${projectId}`;
  const cached = getCached<unknown>(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const config = loadStellarConfig();
  const server = getStellarRpcServer();

  let sourceAccount;
  try {
    sourceAccount = await executeWithRetry(() => server.getAccount(config.simulatorAccount));
  } catch {
    throw new RequestValidationError("simulator account not found on selected network");
  }

  const contract = new Contract(config.contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase
  })
    .addOperation(contract.call("get_project", nativeToScVal(projectId, { type: "symbol" })))
    .setTimeout(300)
    .build();

  const simulated = await executeWithRetry(() => server.simulateTransaction(tx));
  const retval = "result" in simulated ? simulated.result?.retval : undefined;
  if (!retval) {
    return null;
  }

  const project = scValToNative(retval) as unknown;
  const result = project ?? null;
  if (result !== null) {
    setCached(cacheKey, result);
  }
  return result;
}

interface LockProjectRequest {
  projectId: string;
  owner: string;
}

async function buildLockProjectUnsignedXdr(input: LockProjectRequest) {
  const config = loadStellarConfig();
  const server = getStellarRpcServer();

  let sourceAccount;
  try {
    sourceAccount = await executeWithRetry(() => server.getAccount(input.owner));
  } catch {
    throw new RequestValidationError("owner account not found on selected network");
  }

  let args: xdr.ScVal[];
  try {
    args = buildLockProjectContractArgs(input);
  } catch {
    throw new RequestValidationError("owner address must be a valid Stellar address");
  }

  const contract = new Contract(config.contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase
  })
    .addOperation(
      contract.call("lock_project", ...args)
    )
    .setTimeout(300)
    .build();

  const preparedTx = await executeWithRetry(() => server.prepareTransaction(tx));
  return {
    xdr: preparedTx.toXDR(),
    metadata: {
      contractId: config.contractId,
      networkPassphrase: config.networkPassphrase,
      sourceAccount: input.owner,
      sequenceNumber: preparedTx.sequence,
      fee: preparedTx.fee,
      operation: "lock_project"
    }
  };
}

interface DepositRequest {
  projectId: string;
  from: string;
  amount: number;
}

async function buildDepositUnsignedXdr(input: DepositRequest) {
  const config = loadStellarConfig();
  const server = getStellarRpcServer();

  let sourceAccount;
  try {
    sourceAccount = await executeWithRetry(() => server.getAccount(input.from));
  } catch {
    throw new RequestValidationError("from account not found on selected network");
  }

  let args: xdr.ScVal[];
  try {
    args = buildDepositContractArgs(input);
  } catch {
    throw new RequestValidationError("from address must be a valid Stellar address");
  }

  const contract = new Contract(config.contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase
  })
    .addOperation(
      contract.call("deposit", ...args)
    )
    .setTimeout(300)
    .build();

  const preparedTx = await executeWithRetry(() => server.prepareTransaction(tx));
  return {
    xdr: preparedTx.toXDR(),
    metadata: {
      contractId: config.contractId,
      networkPassphrase: config.networkPassphrase,
      sourceAccount: input.from,
      sequenceNumber: preparedTx.sequence,
      fee: preparedTx.fee,
      operation: "deposit"
    }
  };
}

interface UpdateCollaboratorsRequest {
  projectId: string;
  owner: string;
  collaborators: Array<z.infer<typeof collaboratorSchema>>;
}

async function buildUpdateCollaboratorsUnsignedXdr(
  input: UpdateCollaboratorsRequest
) {
  const config = loadStellarConfig();
  const server = getStellarRpcServer();

  let sourceAccount;
  try {
    sourceAccount = await executeWithRetry(() => server.getAccount(input.owner));
  } catch {
    throw new RequestValidationError("owner account not found on selected network");
  }

  let args: xdr.ScVal[];
  try {
    args = buildUpdateCollaboratorsContractArgs(input);
  } catch {
    throw new RequestValidationError("owner/token/collaborator addresses must be valid Stellar addresses");
  }

  const contract = new Contract(config.contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase
  })
    .addOperation(
      contract.call("update_collaborators", ...args)
    )
    .setTimeout(300)
    .build();

  const preparedTx = await executeWithRetry(() => server.prepareTransaction(tx));
  return {
    xdr: preparedTx.toXDR(),
    metadata: {
      contractId: config.contractId,
      networkPassphrase: config.networkPassphrase,
      sourceAccount: input.owner,
      sequenceNumber: preparedTx.sequence,
      fee: preparedTx.fee,
      operation: "update_collaborators"
    }
  };
}

async function buildUpdateMetadataUnsignedXdr(input: {
  projectId: string;
  owner: string;
  title: string;
  projectType: string;
}) {
  const config = loadStellarConfig();
  const server = new rpc.Server(config.sorobanRpcUrl, { allowHttp: true });

  let sourceAccount;
  try {
    sourceAccount = await executeWithRetry(() => server.getAccount(input.owner));
  } catch {
    throw new RequestValidationError("owner account not found on selected network");
  }

  let ownerAddress: Address;
  try {
    ownerAddress = Address.fromString(input.owner);
  } catch {
    throw new RequestValidationError("owner address must be a valid Stellar address");
  }

  const contract = new Contract(config.contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase
  })
    .addOperation(
      contract.call(
        "update_project_metadata",
        nativeToScVal(input.projectId, { type: "symbol" }),
        ownerAddress.toScVal(),
        nativeToScVal(input.title),
        nativeToScVal(input.projectType)
      )
    )
    .setTimeout(300)
    .build();

  const preparedTx = await executeWithRetry(() => server.prepareTransaction(tx));
  return {
    xdr: preparedTx.toXDR(),
    metadata: {
      contractId: config.contractId,
      networkPassphrase: config.networkPassphrase,
      sourceAccount: input.owner,
      sequenceNumber: preparedTx.sequence,
      fee: preparedTx.fee,
      operation: "update_project_metadata"
    }
  };
}

export const listProjectsSchema = z.object({
  start: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().optional(),
  type: z.string().optional(),
});

splitsRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = listProjectsSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(
        ErrorType.VALIDATION,
        ErrorCode.VALIDATION_ERROR,
        "Invalid request payload.",
        undefined,
        parsed.error.flatten()
      );
    }

    const { start, limit, search, type } = parsed.data;
    const projects = await listProjects(start, limit, search, type);
    return res.status(200).json(serializeBigInts(projects));
  } catch (error) {
    return next(error);
  }
});

splitsRouter.get("/:projectId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsedId = projectIdParamSchema.safeParse(req.params.projectId);
    if (!parsedId.success) {
      throw new AppError(
        ErrorType.VALIDATION,
        ErrorCode.VALIDATION_ERROR,
        "Invalid projectId format.",
        undefined,
        parsedId.error.flatten()
      );
    }
    const projectId = parsedId.data;

    const project = await fetchProjectById(projectId);
    if (!project) {
      throw new AppError(
        ErrorType.RPC,
        ErrorCode.NOT_FOUND,
        `Split project ${projectId} not found.`
      );
    }

    return res.status(200).json(serializeBigInts(project));
  } catch (error) {
    return next(error);
  }
});

splitsRouter.post("/:projectId/lock", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsedId = projectIdParamSchema.safeParse(req.params.projectId);
    if (!parsedId.success) {
      throw new AppError(
        ErrorType.VALIDATION,
        ErrorCode.VALIDATION_ERROR,
        "Invalid projectId format.",
        undefined,
        parsedId.error.flatten()
      );
    }
    const projectId = parsedId.data;

    const parsedBody = lockProjectSchema.safeParse(req.body);

    if (!parsedBody.success) {
      throw new AppError(
        ErrorType.VALIDATION,
        ErrorCode.VALIDATION_ERROR,
        "Invalid request payload.",
        { message: "Check owner address." },
        parsedBody.error.flatten()
      );
    }

    const result = await buildLockProjectUnsignedXdr({
      projectId,
      owner: parsedBody.data.owner
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      throw new AppError(ErrorType.VALIDATION, ErrorCode.VALIDATION_ERROR, error.message);
    }
    return next(error);
  }
});

splitsRouter.get("/admin/allowlist", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestId = res.locals.requestId;
    const parsed = allowlistQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status().json({
        error: ,
        message: ,
        requestId,
        details: 
      });
    }

    const { start, limit } = parsed.data;

    try {
      const [adminRetval, countRetval, tokensRetval] = await Promise.all([
        simulateReadOnlyContractCall("get_admin"),
        simulateReadOnlyContractCall("get_allowed_token_count"),
        simulateReadOnlyContractCall("get_allowed_tokens", [
          xdr.ScVal.scvU32(start),
          xdr.ScVal.scvU32(limit)
        ])
      ]);

      const adminValue = adminRetval ? scValToNative(adminRetval) : null;
      const countValue = countRetval ? scValToNative(countRetval) : 0;
      const tokensValue = tokensRetval ? scValToNative(tokensRetval) : [];

      return res.status(200).json(
        serializeBigInts({ admin: adminValue, count: countValue, tokens: tokensValue })
      );
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return res.status().json({
        error: ,
        message: ,
        requestId,
        details: {}
      });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

splitsRouter.post("/:projectId/deposit", async (req, res, next) => {
  try {
    const requestId = res.locals.requestId;

    const parsedParams = projectIdParamSchema.safeParse(req.params.projectId);
    const parsedBody = depositSchema.safeParse(req.body);

    if (!parsedParams.success || !parsedBody.success) {
      return res.status(400).json({
        error: "validation_error",
        message: "Invalid request payload.",
        details: {
          params: parsedParams.success ? null : parsedParams.error.flatten(),
          body: parsedBody.success ? null : parsedBody.error.flatten()
        },
        requestId,
        details: {}});
    }

    try {
      const result = await buildDepositUnsignedXdr({
        projectId: parsedParams.data,
        from: parsedBody.data.from,
        amount: parsedBody.data.amount
      });
      // Evict cached project state; balance will change after submission
      invalidateCache(`project:${parsedParams.data}`);
      invalidateCacheByPrefix("list_projects:");
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return res.status().json({
        error: ,
        message: ,
        requestId,
        details: {}
      });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

splitsRouter.patch("/:projectId/metadata", async (req, res, next) => {
  try {
    const requestId = res.locals.requestId;

    const parsedParams = projectIdParamSchema.safeParse(req.params.projectId);
    const parsedBody = updateMetadataSchema.safeParse(req.body);

    if (!parsedParams.success || !parsedBody.success) {
      return res.status(400).json({
        error: "validation_error",
        message: "Invalid request payload.",
        details: {
          params: parsedParams.success ? null : parsedParams.error.flatten(),
          body: parsedBody.success ? null : parsedBody.error.flatten()
        },
        requestId,
        details: {}});
    }

    try {
      const result = await buildUpdateMetadataUnsignedXdr({
        projectId: parsedParams.data,
        owner: parsedBody.data.owner,
        title: parsedBody.data.title,
        projectType: parsedBody.data.projectType
      });
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return res.status().json({
        error: ,
        message: ,
        requestId,
        details: {}
      });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

splitsRouter.put("/:projectId/collaborators", async (req, res, next) => {
  try {
    const requestId = res.locals.requestId;

    const parsedParams = projectIdParamSchema.safeParse(req.params.projectId);
    const parsedBody = updateCollaboratorsSchema.safeParse(req.body);

    if (!parsedParams.success || !parsedBody.success) {
      return res.status(400).json({
        error: "validation_error",
        message: "Invalid request payload.",
        details: {
          params: parsedParams.success ? null : parsedParams.error.flatten(),
          body: parsedBody.success ? null : parsedBody.error.flatten()
        },
        requestId,
        details: {}});
    }

    try {
      const result = await buildUpdateCollaboratorsUnsignedXdr({
        projectId: parsedParams.data,
        owner: parsedBody.data.owner,
        collaborators: parsedBody.data.collaborators
      });
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return res.status().json({
        error: ,
        message: ,
        requestId,
        details: {}
      });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

splitsRouter.post("/", async (req, res, next) => {
  try {
    const requestId = res.locals.requestId;
    const parsed = createSplitSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status().json({
        error: ,
        message: ,
        requestId,
        details: 
      });
    }

    try {
      const result = await buildCreateProjectUnsignedXdr(parsed.data);
      // Invalidate list cache so newly created project appears immediately
      invalidateCacheByPrefix("list_projects:");
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return res.status().json({
        error: ,
        message: ,
        requestId,
        details: {}
      });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

export const distributeSchema = z.object({
  sourceAddress: z.string().min(1, "sourceAddress is required").optional()
});

splitsRouter.post("/:projectId/distribute", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsedId = projectIdParamSchema.safeParse(req.params.projectId);
    if (!parsedId.success) {
      throw new AppError(
        ErrorType.VALIDATION,
        ErrorCode.VALIDATION_ERROR,
        "Invalid projectId format.",
        undefined,
        parsedId.error.flatten()
      );
    }
    const projectId = parsedId.data;

    const parsedBody = distributeSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new AppError(
        ErrorType.VALIDATION,
        ErrorCode.VALIDATION_ERROR,
        "Invalid request payload.",
        { message: "Check the distribution request body." },
        parsedBody.error.flatten()
      );
    }

    const config = loadStellarConfig();
    const sourceAddress = parsedBody.data.sourceAddress || config.simulatorAccount;

    try {
      const result = await buildUnsignedContractCall({
        sourceAddress,
        sourceRoleLabel: "source",
        operation: "distribute",
        args: [nativeToScVal(projectId, { type: "symbol" })]
      });

      // Evict cached project data; distribution round and balance will change
      invalidateCache(`project:${projectId}`);
      invalidateCacheByPrefix("list_projects:");

      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        throw new AppError(
          ErrorType.ACCOUNT_STATE,
          ErrorCode.ACCOUNT_NOT_FOUND,
          error.message,
          { message: "The account used to trigger distribution must exist and be funded.", action: "Check Source Wallet" }
        );
      }
      throw translateSorobanError(error);
    }
  } catch (error) {
    return next(error);
  }
});

splitsRouter.get("/:projectId/claimable/:address", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestId = res.locals.requestId;
    const parsedProjectId = projectIdParamSchema.safeParse(req.params.projectId);
    const parsedAddress = stellarAddressSchema.safeParse(req.params.address);

    if (!parsedProjectId.success || !parsedAddress.success) {
      return res.status(400).json({
        error: "validation_error",
        message: "Invalid request payload.",
        details: {
          params: {
            projectId: parsedProjectId.success ? null : parsedProjectId.error.flatten(),
            address: parsedAddress.success ? null : parsedAddress.error.flatten()
          }
        },
        requestId,
        details: {}});
    }

    const projectId = parsedProjectId.data;
    const address = parsedAddress.data;
    const config = loadStellarConfig();
    const server = getStellarRpcServer();

    let sourceAccount;
    try {
      sourceAccount = await executeWithRetry(() => server.getAccount(config.simulatorAccount));
    } catch {
      return res.status().json({
        error: ,
        message: ,
        requestId,
        details: {}
      });
    }

    let simulated;
    try {
      const contract = new Contract(config.contractId);
      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: config.networkPassphrase
      })
        .addOperation(
          contract.call(
            "get_claimable",
            nativeToScVal(projectId, { type: "symbol" }),
            Address.fromString(address).toScVal()
          )
        )
        .setTimeout(300)
        .build();

      simulated = await executeWithRetry(() => server.simulateTransaction(tx));
    } catch (error) {
      throw translateSorobanError(error);
    }

    const retval = "result" in simulated ? simulated.result?.retval : undefined;
    if (!retval) {
      return res.status().json({
        error: ,
        message: ,
        requestId,
        details: {}
      });
    }

    return res.status(200).json({
      projectId,
      address,
      claimable: serializeBigInts(scValToNative(retval))
    });
  } catch (error) {
    return next(error);
  }
});

const adminTokenSchema = z.object({
  admin: stellarAddressSchema.describe("admin"),
  token: stellarAddressSchema.describe("token")
});

interface AdminTokenRequest {
  admin: string;
  token: string;
}

const pauseDistributionsSchema = z.object({
  admin: stellarAddressSchema.describe("admin")
});

interface PauseDistributionsRequest {
  admin: string;
}

async function buildPauseDistributionsUnsignedXdr(input: PauseDistributionsRequest) {
  const config = loadStellarConfig();
  const server = getStellarRpcServer();

  let sourceAccount;
  try {
    sourceAccount = await executeWithRetry(() => server.getAccount(input.admin));
  } catch {
    throw new RequestValidationError("admin account not found on selected network");
  }

  const adminAddress = Address.fromString(input.admin);
  const contract = new Contract(config.contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase
  })
    .addOperation(contract.call("pause_distributions", adminAddress.toScVal()))
    .setTimeout(300)
    .build();

  const preparedTx = await executeWithRetry(() => server.prepareTransaction(tx));
  return {
    xdr: preparedTx.toXDR(),
    metadata: {
      contractId: config.contractId,
      networkPassphrase: config.networkPassphrase,
      sourceAccount: input.admin,
      sequenceNumber: preparedTx.sequence,
      fee: preparedTx.fee,
      operation: "pause_distributions"
    }
  };
}

async function buildUnpauseDistributionsUnsignedXdr(input: PauseDistributionsRequest) {
  const config = loadStellarConfig();
  const server = getStellarRpcServer();

  let sourceAccount;
  try {
    sourceAccount = await executeWithRetry(() => server.getAccount(input.admin));
  } catch {
    throw new RequestValidationError("admin account not found on selected network");
  }

  const adminAddress = Address.fromString(input.admin);
  const contract = new Contract(config.contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase
  })
    .addOperation(contract.call("unpause_distributions", adminAddress.toScVal()))
    .setTimeout(300)
    .build();

  const preparedTx = await executeWithRetry(() => server.prepareTransaction(tx));
  return {
    xdr: preparedTx.toXDR(),
    metadata: {
      contractId: config.contractId,
      networkPassphrase: config.networkPassphrase,
      sourceAccount: input.admin,
      sequenceNumber: preparedTx.sequence,
      fee: preparedTx.fee,
      operation: "unpause_distributions"
    }
  };
}

async function buildAllowTokenUnsignedXdr(
  input: AdminTokenRequest
): Promise<UnsignedTxResponse> {
  parseStellarAddress(input.admin, "admin address");
  parseStellarAddress(input.token, "token address");
  const args = buildAdminTokenContractArgs(input);

  return buildUnsignedContractCall({
    sourceAddress: input.admin,
    sourceRoleLabel: "admin",
    operation: "allow_token",
    args
  });
}

async function buildDisallowTokenUnsignedXdr(
  input: AdminTokenRequest
): Promise<UnsignedTxResponse> {
  parseStellarAddress(input.admin, "admin address");
  parseStellarAddress(input.token, "token address");
  const args = buildAdminTokenContractArgs(input);

  return buildUnsignedContractCall({
    sourceAddress: input.admin,
    sourceRoleLabel: "admin",
    operation: "disallow_token",
    args
  });
}

splitsRouter.post("/admin/allow-token", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestId = res.locals.requestId;
    const parsed = adminTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status().json({
        error: ,
        message: ,
        requestId,
        details: 
      });
    }

    try {
      const result = await buildAllowTokenUnsignedXdr(parsed.data);
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return res.status().json({
        error: ,
        message: ,
        requestId,
        details: {}
      });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

splitsRouter.post("/admin/disallow-token", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestId = res.locals.requestId;
    const parsed = adminTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status().json({
        error: ,
        message: ,
        requestId,
        details: 
      });
    }

    try {
      const result = await buildDisallowTokenUnsignedXdr(parsed.data);
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return res.status().json({
        error: ,
        message: ,
        requestId,
        details: {}
      });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

splitsRouter.post("/admin/pause-distributions", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestId = res.locals.requestId;
    const parsed = pauseDistributionsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status().json({
        error: ,
        message: ,
        requestId,
        details: 
      });
    }

    try {
      const result = await buildPauseDistributionsUnsignedXdr(parsed.data);
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return res.status().json({
        error: ,
        message: ,
        requestId,
        details: {}
      });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

splitsRouter.post("/admin/unpause-distributions", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestId = res.locals.requestId;
    const parsed = pauseDistributionsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status().json({
        error: ,
        message: ,
        requestId,
        details: 
      });
    }

    try {
      const result = await buildUnpauseDistributionsUnsignedXdr(parsed.data);
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return res.status().json({
        error: ,
        message: ,
        requestId,
        details: {}
      });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

export const historyQuerySchema = z.object({
  cursor: z.string().default(""),
  limit: z.coerce.number().int().min(1).max(200).default(100)
});

splitsRouter.get("/:projectId/history", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsedId = projectIdParamSchema.safeParse(req.params.projectId);
    if (!parsedId.success) {
      throw new AppError(
        ErrorType.VALIDATION,
        ErrorCode.VALIDATION_ERROR,
        "Invalid projectId format.",
        undefined,
        parsedId.error.flatten()
      );
    }
    const projectId = parsedId.data;

    const parsedQuery = historyQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      throw new AppError(
        ErrorType.VALIDATION,
        ErrorCode.VALIDATION_ERROR,
        "Invalid query parameters.",
        { message: "Check cursor and limit parameters." }
      );
    }
    const { cursor, limit } = parsedQuery.data;

    const config = loadStellarConfig();
    const server = getStellarRpcServer();

    const { topicProjectId, roundTopic, paymentTopic } = buildHistoryTopicFilters(projectId);

    const roundEventResponse = await executeWithRetry(() => server.getEvents({
      cursor,
      filters: [
        {
          type: "contract",
          contractIds: [config.contractId],
          topics: [[roundTopic], [topicProjectId]]
        }
      ],
      limit
    }));

    const paymentEventResponse = await executeWithRetry(() => server.getEvents({
      cursor,
      filters: [
        {
          type: "contract",
          contractIds: [config.contractId],
          topics: [[paymentTopic], [topicProjectId]]
        }
      ],
      limit
    }));

    const events = [
      ...roundEventResponse.events.map((e) => {
        const decoded = decodeRoundHistoryEventValue(e.value);
        return {
          type: "round",
          round: decoded.round,
          amount: decoded.amount,
          txHash: e.txHash,
          ledgerCloseTime: e.ledgerClosedAt,
          id: e.id
        };
      }),
      ...paymentEventResponse.events.map((e) => {
        const decoded = decodePaymentHistoryEventValue(e.value);
        return {
          type: "payment",
          recipient: decoded.recipient,
          amount: decoded.amount,
          txHash: e.txHash,
          ledgerCloseTime: e.ledgerClosedAt,
          id: e.id
        };
      })
    ].sort((a, b) => b.ledgerCloseTime.localeCompare(a.ledgerCloseTime));

    // Prefer the server-provided pagination cursor when available
    const nextCursor =
      // soroban-rpc getEvents commonly returns `cursor` for pagination
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((roundEventResponse as any)?.cursor as string | undefined) ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((paymentEventResponse as any)?.cursor as string | undefined) ||
      null;

    return res.status(200).json({
      items: serializeBigInts(events),
      nextCursor
    });
  } catch (error) {
    return next(error);
  }
});

// ============================================================
// Issue #152: Admin contract-state read routes
// ============================================================

splitsRouter.get("/admin/status", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestId = res.locals.requestId;
    try {
      const [adminRetval, pausedRetval] = await Promise.all([
        simulateReadOnlyContractCall("get_admin"),
        simulateReadOnlyContractCall("is_distributions_paused")
      ]);

      const admin = adminRetval ? String(scValToNative(adminRetval)) : null;
      const isPaused = pausedRetval ? Boolean(scValToNative(pausedRetval)) : false;

      return res.status(200).json({ admin, isPaused });
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return res.status(400).json({ error: "validation_error", message: error.message, requestId, details: {} });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

const isTokenAllowedQuerySchema = z.object({
  token: stellarAddressSchema.describe("token contract address to check")
});

splitsRouter.get("/admin/is-token-allowed", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestId = res.locals.requestId;
    const parsed = isTokenAllowedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status().json({
        error: ,
        message: ,
        requestId,
        details: 
      });
    }
    const { token } = parsed.data;

    try {
      const retval = await simulateReadOnlyContractCall("is_token_allowed", [
        Address.fromString(token).toScVal()
      ]);
      const isAllowed = retval ? Boolean(scValToNative(retval)) : false;
      return res.status(200).json({ token, isAllowed });
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return res.status(400).json({ error: "validation_error", message: error.message, requestId, details: {} });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

splitsRouter.get("/admin/token-count", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestId = res.locals.requestId;
    try {
      const retval = await simulateReadOnlyContractCall("get_allowed_token_count");
      const count = retval ? Number(scValToNative(retval)) : 0;
      return res.status(200).json({ count });
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return res.status(400).json({ error: "validation_error", message: error.message, requestId, details: {} });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

// ============================================================
// Issue #166: Unallocated token recovery routes
// ============================================================

const unallocatedQuerySchema = z.object({
  token: stellarAddressSchema.describe("token contract address")
});

splitsRouter.get("/admin/unallocated", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestId = res.locals.requestId;
    const parsed = unallocatedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status().json({
        error: ,
        message: ,
        requestId,
        details: 
      });
    }
    const { token } = parsed.data;

    try {
      const retval = await simulateReadOnlyContractCall("get_unallocated_balance", [
        Address.fromString(token).toScVal()
      ]);
      const unallocated = retval ? String(scValToNative(retval)) : "0";
      return res.status(200).json({ token, unallocated });
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return res.status(400).json({ error: "validation_error", message: error.message, requestId, details: {} });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

export const withdrawUnallocatedSchema = z.object({
  admin: stellarAddressSchema.describe("admin"),
  token: stellarAddressSchema.describe("token contract address"),
  to: stellarAddressSchema.describe("destination address"),
  amount: z
    .number()
    .positive("amount must be greater than 0")
    .describe("amount in stroops to recover")
});

type WithdrawUnallocatedRequest = z.infer<typeof withdrawUnallocatedSchema>;

async function buildWithdrawUnallocatedUnsignedXdr(input: WithdrawUnallocatedRequest) {
  const config = loadStellarConfig();
  const server = getStellarRpcServer();

  let sourceAccount;
  try {
    sourceAccount = await executeWithRetry(() => server.getAccount(input.admin));
  } catch {
    throw new RequestValidationError("admin account not found on selected network");
  }

  const adminAddress = Address.fromString(input.admin);
  const tokenAddress = Address.fromString(input.token);
  const toAddress = Address.fromString(input.to);

  const contract = new Contract(config.contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase
  })
    .addOperation(
      contract.call(
        "withdraw_unallocated",
        adminAddress.toScVal(),
        tokenAddress.toScVal(),
        toAddress.toScVal(),
        nativeToScVal(input.amount, { type: "i128" })
      )
    )
    .setTimeout(300)
    .build();

  const preparedTx = await executeWithRetry(() => server.prepareTransaction(tx));
  return {
    xdr: preparedTx.toXDR(),
    metadata: {
      contractId: config.contractId,
      networkPassphrase: config.networkPassphrase,
      sourceAccount: input.admin,
      sequenceNumber: preparedTx.sequence,
      fee: preparedTx.fee,
      operation: "withdraw_unallocated",
      auditContext: {
        token: input.token,
        destination: input.to,
        amount: input.amount,
        initiatedAt: new Date().toISOString()
      }
    }
  };
}

splitsRouter.post("/admin/withdraw-unallocated", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestId = res.locals.requestId;
    const parsed = withdrawUnallocatedSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status().json({
        error: ,
        message: ,
        requestId,
        details: 
      });
    }

    try {
      const result = await buildWithdrawUnallocatedUnsignedXdr(parsed.data);
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return res.status(400).json({ error: "validation_error", message: error.message, requestId, details: {} });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

// ============================================================
// Cache diagnostics (non-sensitive internal endpoint)
// ============================================================

splitsRouter.get("/admin/cache-stats", (_req: Request, res: Response) => {
  res.status(200).json({ ...getCacheStats(), ttlMs: READ_CACHE_TTL_MS });
});
