import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../lib/retry";

describe("withRetry", () => {
  it("resolves on first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, 3, 0);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and eventually resolves", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, 3, 0);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after max attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    await expect(withRetry(fn, 3, 0)).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  describe("shouldRetry predicate", () => {
    it("stops immediately when predicate returns false", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("no retry"));
      const shouldRetry = vi.fn().mockReturnValue(false);

      await expect(withRetry(fn, 3, 0, shouldRetry)).rejects.toThrow("no retry");
      // Called once, predicate said no — no further attempts
      expect(fn).toHaveBeenCalledTimes(1);
      expect(shouldRetry).toHaveBeenCalledTimes(1);
    });

    it("retries when predicate returns true", async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValue("recovered");
      const shouldRetry = vi.fn().mockReturnValue(true);

      const result = await withRetry(fn, 3, 0, shouldRetry);
      expect(result).toBe("recovered");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("passes the thrown error to the predicate", async () => {
      const err = new Error("specific error");
      const fn = vi.fn().mockRejectedValue(err);
      const shouldRetry = vi.fn().mockReturnValue(false);

      await expect(withRetry(fn, 3, 0, shouldRetry)).rejects.toThrow("specific error");
      expect(shouldRetry).toHaveBeenCalledWith(err);
    });

    it("behaves as before (always retries) when no predicate is provided", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("always fails"));
      await expect(withRetry(fn, 3, 0)).rejects.toThrow("always fails");
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });
});