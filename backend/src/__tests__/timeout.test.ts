import { describe, it, expect, vi, beforeEach } from "vitest";
import { requestTimeout } from "../middleware/timeout";
import type { Request, Response, NextFunction } from "express";

function makeRes(overrides: Partial<Response> = {}): Response {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    headersSent: false,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    on: vi.fn((event: string, cb: () => void) => { (listeners[event] ??= []).push(cb); }),
    emit: (event: string) => listeners[event]?.forEach((cb) => cb()),
    ...overrides,
  } as unknown as Response;
}

describe("requestTimeout middleware", () => {
  beforeEach(() => vi.useFakeTimers());

  it("calls next immediately", () => {
    const next = vi.fn() as unknown as NextFunction;
    const middleware = requestTimeout(1000);
    middleware({} as Request, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("sends 503 after timeout if headers not sent", () => {
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    requestTimeout(100)({} as Request, res, next);
    vi.advanceTimersByTime(200);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});