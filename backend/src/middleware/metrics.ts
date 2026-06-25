import type { RequestHandler } from "express";
import {
  decrementInflightRequests,
  incrementInflightRequests,
  recordRequestMetrics,
} from "../services/metrics.js";

function sanitizeRoute(req: Parameters<RequestHandler>[0]): string {
  const baseUrl = req.baseUrl ?? "";
  const routePath = req.route?.path ?? req.path;
  const route = `${baseUrl}${routePath}`.replace(/\/$/, "") || "/";
  return route;
}

export const metricsMiddleware: RequestHandler = (req, res, next) => {
  incrementInflightRequests();
  const start = process.hrtime.bigint();
  let ended = false;

  const finalize = () => {
    if (ended) return;
    ended = true;
    decrementInflightRequests();
  };

  res.once("finish", () => {
    const elapsedNs = Number(process.hrtime.bigint() - start);
    const elapsedMs = elapsedNs / 1_000_000;
    const route = sanitizeRoute(req);
    recordRequestMetrics(req.method, route, res.statusCode, elapsedMs);
    finalize();
  });

  res.once("close", finalize);
  next();
};
