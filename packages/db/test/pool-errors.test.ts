import { EventEmitter } from "node:events";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { guardPoolErrors } from "../src/pool-errors";

describe("guardPoolErrors", () => {
  it("logs an error from a checked-out client instead of throwing", () => {
    const pool = guardPoolErrors(new pg.Pool(), "test");
    const client = new EventEmitter() as unknown as pg.PoolClient;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    pool.emit("acquire", client);
    pool.emit("acquire", client);
    expect(client.listenerCount("error")).toBe(1);
    expect(() => client.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    expect(log).toHaveBeenCalledWith("[test] checked-out connection error:", "Connection terminated unexpectedly");
    pool.emit("release", undefined, client);
    expect(client.listenerCount("error")).toBe(0);
    expect(() => pool.emit("error", new Error("idle drop"), client)).not.toThrow();
    log.mockRestore();
  });
});
