import { Router } from "express";
import { getEnvDiagnostics } from "../config/env.js";
import { getDataSource } from "../services/database.js";
import { checkSorobanReachability } from "../services/stellar.js";

export const healthRouter = Router();

/**
 * Health endpoint - indicates service is running
 * Returns 200 OK if the service process is healthy
 */
healthRouter.get("/", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

/**
 * Liveness endpoint - indicates service is not in a broken state
 * Returns 200 OK if the service is alive (should not be restarted)
 */
healthRouter.get("/live", (_req, res) => {
  res.json({
    status: "ok"
  });
});

/**
 * Readiness endpoint - indicates service is ready to serve traffic
 * Returns 200 OK if all dependencies (env, database) are ready
 * Returns 503 Service Unavailable if any dependency is missing
 */
healthRouter.get("/ready", async (_req, res, next) => {
  const requestId = res.locals.requestId;
  const components = {
    env: { ok: true },
    db: { ok: false, message: "" },
    rpc: { ok: false, message: "" },
    contract: { ok: false, message: "" }
  };
  
  // Check environment variables
  const envDiagnostics = getEnvDiagnostics();
  if (!envDiagnostics.ok) {
    components.env = { ok: false };
    res.status(503).json({
      status: "not_ready",
      error: "missing_config",
      message: "Required environment variables are missing or malformed.",
      components,
      issues: envDiagnostics.issues,
      requestId,
        details: {}});
    return;
  }

  // Check database connection
  try {
    getDataSource();
    components.db = { ok: true, message: "connected" };
  } catch (dbError) {
    components.db = {
      ok: false,
      message: dbError instanceof Error ? dbError.message : "Database connection is not available."
    };
    res.status(503).json({
      status: "not_ready",
      error: "database_unavailable",
      message: "Database connection is not available.",
      components,
      requestId,
        details: {}});
    return;
  }

  try {
    const soroban = await checkSorobanReachability();
    components.rpc = { ok: soroban.rpc.ok, message: soroban.rpc.message ?? "reachable" };
    components.contract = {
      ok: soroban.contract.ok,
      message: soroban.contract.message ?? "simulation_ok"
    };

    if (!soroban.rpc.ok || !soroban.contract.ok) {
      res.status(503).json({
        status: "not_ready",
        error: !soroban.rpc.ok ? "rpc_unavailable" : "contract_unreachable",
        message: "Soroban RPC or contract simulation is not ready.",
        components,
        requestId,
        details: {}});
      return;
    }
  } catch (error) {
    next(error);
    return;
  }

  res.json({ status: "ready", components });
});
