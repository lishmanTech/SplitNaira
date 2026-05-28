import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataSource } from "typeorm";
import { clearEnvCache } from "../config/env.js";
import { closeDatabase, initDatabase, withTransaction } from "./database.js";

const testEnv = {
  DATABASE_URL: "postgres://test:test@localhost:5432/splitnaira_test",
  HORIZON_URL: "https://horizon-testnet.stellar.org",
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  SIMULATOR_ACCOUNT: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  NODE_ENV: "test"
};

function applyTestEnv(): void {
  for (const [key, value] of Object.entries(testEnv)) {
    process.env[key] = value;
  }
}

function clearTestEnv(): void {
  for (const key of Object.keys(testEnv)) {
    delete process.env[key];
  }
}

describe("database initialization", () => {
  beforeEach(async () => {
    applyTestEnv();
    clearEnvCache();
    await closeDatabase();
  });

  afterEach(async () => {
    await closeDatabase();
    vi.restoreAllMocks();
    clearEnvCache();
    clearTestEnv();
  });

  it("shares one in-flight initialization across concurrent calls", async () => {
    let releaseInitialize: () => void = () => undefined;
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });

    const initializeSpy = vi.spyOn(DataSource.prototype, "initialize").mockImplementation(async function (this: DataSource) {
      await initializationGate;
      this.isInitialized = true;
      return this;
    });

    const destroySpy = vi.spyOn(DataSource.prototype, "destroy").mockImplementation(async function (this: DataSource) {
      this.isInitialized = false;
    });

    const first = initDatabase();
    const second = initDatabase();

    expect(initializeSpy).toHaveBeenCalledTimes(1);

    releaseInitialize();

    const [firstDataSource, secondDataSource] = await Promise.all([first, second]);

    expect(firstDataSource).toBe(secondDataSource);
    expect(firstDataSource.isInitialized).toBe(true);
    expect(initializeSpy).toHaveBeenCalledTimes(1);

    await closeDatabase();
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });
});

describe("withTransaction", () => {
  beforeEach(async () => {
    applyTestEnv();
    clearEnvCache();
    await closeDatabase();
  });

  afterEach(async () => {
    await closeDatabase();
    vi.restoreAllMocks();
    clearEnvCache();
    clearTestEnv();
  });

  it("commits when the callback succeeds", async () => {
    vi.spyOn(DataSource.prototype, "initialize").mockImplementation(async function (this: DataSource) {
      this.isInitialized = true;
      return this;
    });
    vi.spyOn(DataSource.prototype, "destroy").mockImplementation(async function (this: DataSource) {
      this.isInitialized = false;
    });

    const commitMock = vi.fn();
    const rollbackMock = vi.fn();
    const releaseMock = vi.fn();
    const connectMock = vi.fn();
    const startTransactionMock = vi.fn();

    const queryRunner = {
      connect: connectMock,
      startTransaction: startTransactionMock,
      commitTransaction: commitMock,
      rollbackTransaction: rollbackMock,
      release: releaseMock,
      manager: {}
    };

    vi.spyOn(DataSource.prototype, "createQueryRunner").mockReturnValue(
      queryRunner as unknown as ReturnType<DataSource["createQueryRunner"]>
    );

    await initDatabase();
    const result = await withTransaction(async () => "ok");

    expect(result).toBe("ok");
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(rollbackMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("rolls back when the callback throws", async () => {
    vi.spyOn(DataSource.prototype, "initialize").mockImplementation(async function (this: DataSource) {
      this.isInitialized = true;
      return this;
    });
    vi.spyOn(DataSource.prototype, "destroy").mockImplementation(async function (this: DataSource) {
      this.isInitialized = false;
    });

    const commitMock = vi.fn();
    const rollbackMock = vi.fn();
    const releaseMock = vi.fn();

    const queryRunner = {
      connect: vi.fn(),
      startTransaction: vi.fn(),
      commitTransaction: commitMock,
      rollbackTransaction: rollbackMock,
      release: releaseMock,
      manager: {}
    };

    vi.spyOn(DataSource.prototype, "createQueryRunner").mockReturnValue(
      queryRunner as unknown as ReturnType<DataSource["createQueryRunner"]>
    );

    await initDatabase();

    await expect(
      withTransaction(async () => {
        throw new Error("Database constraint violation");
      })
    ).rejects.toThrow("Database constraint violation");

    expect(rollbackMock).toHaveBeenCalledTimes(1);
    expect(commitMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});
