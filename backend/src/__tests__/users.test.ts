import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorHandler, notFoundHandler } from "../middleware/error.js";
import { requestIdMiddleware } from "../middleware/request-id.js";

const findOneMock = vi.fn();
const createMock = vi.fn();
const saveMock = vi.fn();
const commitMock = vi.fn();
const rollbackMock = vi.fn();
const releaseMock = vi.fn();

vi.mock("../services/database.js", () => ({
  getDataSource: () => ({
    getRepository: () => ({
      findOne: findOneMock,
      create: createMock,
      save: saveMock
    })
  }),
  withTransaction: async (callback: (queryRunner: {
    manager: {
      getRepository: () => {
        findOne: typeof findOneMock;
        create: typeof createMock;
        save: typeof saveMock;
      };
    };
  }) => Promise<unknown>) => {
    const repository = {
      findOne: findOneMock,
      create: createMock,
      save: saveMock
    };
    const mockQueryRunner = {
      manager: { getRepository: () => repository },
      startTransaction: commitMock,
      commitTransaction: commitMock,
      rollbackTransaction: rollbackMock,
      release: releaseMock
    };
    try {
      return await callback(mockQueryRunner);
    } catch (error) {
      rollbackMock();
      throw error;
    }
  }
}));

import { usersRouter } from "../routes/users.js";

const NOW = new Date("2026-04-28T12:00:00.000Z");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use("/users", usersRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("User Registration API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockImplementation((input) => input);
    saveMock.mockImplementation(async (input) => ({
      id: "11111111-1111-4111-8111-111111111111",
      role: "user",
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
      ...input
    }));
  });

  describe("POST /users/register", () => {
    it("should register a new user with valid wallet address", async () => {
      findOneMock.mockResolvedValue(null);
      const app = createApp();

      const response = await request(app)
        .post("/users/register")
        .send({
          walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          email: "test@example.com",
          alias: "TestUser"
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty("id");
      expect(response.body.walletAddress).toBe("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
      expect(response.body.email).toBe("test@example.com");
      expect(response.body.alias).toBe("TestUser");
      expect(response.body.role).toBe("user");
      expect(response.body.isActive).toBe(true);
    });

    it("should register a user without optional fields", async () => {
      findOneMock.mockResolvedValue(null);
      const app = createApp();

      const response = await request(app)
        .post("/users/register")
        .send({
          walletAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty("id");
      expect(response.body.walletAddress).toBe("GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    });

    it("should reject duplicate wallet address", async () => {
      findOneMock.mockResolvedValue({
        id: "existing-user",
        walletAddress: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
      });
      const app = createApp();

      const response = await request(app)
        .post("/users/register")
        .send({ walletAddress: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    it("should reject invalid wallet address format", async () => {
      const app = createApp();

      const response = await request(app)
        .post("/users/register")
        .send({
          walletAddress: "INVALID_ADDRESS"
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    it("should reject invalid email format", async () => {
      const app = createApp();

      const response = await request(app)
        .post("/users/register")
        .send({
          walletAddress: "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
          email: "invalid-email"
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });
  });

  describe("GET /users/:walletAddress", () => {
    it("should retrieve user by wallet address", async () => {
      const walletAddress = "GEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
      findOneMock.mockResolvedValue({
        id: "22222222-2222-4222-8222-222222222222",
        walletAddress,
        email: undefined,
        alias: "GetTestUser",
        role: "user",
        isActive: true,
        createdAt: NOW,
        updatedAt: NOW
      });
      const app = createApp();

      const response = await request(app).get(`/users/${walletAddress}`);

      expect(response.status).toBe(200);
      expect(response.body.walletAddress).toBe(walletAddress);
      expect(response.body.alias).toBe("GetTestUser");
    });

    it("should return 404 for non-existent user", async () => {
      findOneMock.mockResolvedValue(null);
      const app = createApp();

      const response = await request(app)
        .get("/users/GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");

      expect(response.status).toBe(404);
    });

    it("should reject invalid wallet address format", async () => {
      const app = createApp();

      const response = await request(app)
        .get("/users/INVALID");

      expect(response.status).toBe(400);
    });
  });

  describe("Transaction Safety", () => {
    it("should rollback user registration on save failure", async () => {
      findOneMock.mockResolvedValue(null);
      saveMock.mockRejectedValue(new Error("Database constraint violation"));

      const app = createApp();

      const response = await request(app)
        .post("/users/register")
        .send({
          walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          email: "test@example.com",
          alias: "TestUser"
        });

      expect(response.status).toBe(500);
      expect(rollbackMock).toHaveBeenCalled();
    });

  });
});
