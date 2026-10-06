import type pg from "pg";

/**
 * Keep a dropped connection from killing the process. pg-pool listens for
 * client errors only while a client is idle. A client checked out with
 * pool.connect() has no listener, so a Postgres restart during a held
 * transaction raised an unhandled 'error' event and stopped the worker.
 * The caller's pending query still rejects, so logging is enough here.
 */
export function guardPoolErrors(pool: pg.Pool, label: string): pg.Pool {
  const onClientError = (error: Error) => {
    console.error(`[${label}] checked-out connection error:`, error.message);
  };
  pool.on("error", (error) => {
    console.error(`[${label}] idle connection error:`, error instanceof Error ? error.message : error);
  });
  pool.on("acquire", (client) => {
    if (!client.listeners("error").includes(onClientError)) client.on("error", onClientError);
  });
  pool.on("release", (_error, client) => {
    client.removeListener("error", onClientError);
  });
  return pool;
}
