import { Router, Request, Response, NextFunction } from "express";
import { getDataSource, withTransaction } from "../services/database.js";
import { User } from "../entities/User.js";
import { userRegistrationSchema } from "../schemas/user.schemas.js";
import { AppError, ErrorCode, ErrorType } from "../lib/errors.js";
import { logger } from "../services/logger.js";

export const usersRouter = Router();

/**
 * POST /users/register
 * Register a new user with wallet address
 * Transaction-safe: Automatically rolled back on error
 */
usersRouter.post("/register", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestId = res.locals.requestId;

    // Validate request body
    const parsed = userRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        ErrorType.VALIDATION,
        ErrorCode.VALIDATION_ERROR,
        "Invalid request payload.",
        undefined,
        parsed.error.flatten()
      );
    }

    const { walletAddress, email, alias } = parsed.data;

    // Execute user registration within transaction
    const savedUser = await withTransaction(async (queryRunner) => {
      const userRepository = queryRunner.manager.getRepository(User);

      // Check if user already exists
      const existingUser = await userRepository.findOne({
        where: { walletAddress }
      });

      if (existingUser) {
        throw new AppError(
          ErrorType.VALIDATION,
          ErrorCode.VALIDATION_ERROR,
          "User with this wallet address already exists.",
          undefined,
          { walletAddress }
        );
      }

      // Create new user
      const newUser = userRepository.create({
        walletAddress,
        email,
        alias,
        role: "user",
        isActive: true
      });

      // Save to database within transaction
      return await userRepository.save(newUser);
    });

    logger.info("User registered successfully", {
      userId: savedUser.id,
      walletAddress: savedUser.walletAddress,
      requestId
    });

    // Return user data (excluding sensitive fields if any)
    return res.status(201).json({
      id: savedUser.id,
      walletAddress: savedUser.walletAddress,
      email: savedUser.email,
      alias: savedUser.alias,
      role: savedUser.role,
      isActive: savedUser.isActive,
      createdAt: savedUser.createdAt.toISOString(),
      updatedAt: savedUser.updatedAt.toISOString()
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /users/:walletAddress
 * Get user by wallet address
 */
usersRouter.get("/:walletAddress", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { walletAddress } = req.params;

    // Validate wallet address format
    const parsed = userRegistrationSchema.shape.walletAddress.safeParse(walletAddress);
    if (!parsed.success) {
      throw new AppError(
        ErrorType.VALIDATION,
        ErrorCode.VALIDATION_ERROR,
        "Invalid wallet address format.",
        undefined,
        parsed.error.flatten()
      );
    }

    const dataSource = getDataSource();
    const userRepository = dataSource.getRepository(User);

    const user = await userRepository.findOne({
      where: { walletAddress: parsed.data }
    });

    if (!user) {
      throw new AppError(
        ErrorType.RPC,
        ErrorCode.NOT_FOUND,
        `User with wallet address ${walletAddress} not found.`
      );
    }

    return res.status(200).json({
      id: user.id,
      walletAddress: user.walletAddress,
      email: user.email,
      alias: user.alias,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString()
    });
  } catch (error) {
    return next(error);
  }
});
