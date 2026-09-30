import { createServer } from "node:http";
import { chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

type McpServerFactory = () => {
  instance: {
    connect: (transport: Transport) => Promise<void>;
    close?: () => Promise<void>;
  };
};

export type DataSocket = {
  path: string;
  close: () => Promise<void>;
};

/**
 * Serves the run's neko_graphjin MCP server to skill scripts on a Unix socket.
 * Scripts get the same tools, identity, policy and audit as the agent. The
 * broker token stays in this process.
 */
export async function startDataSocket(opts: {
  runId: string;
  buildServer: McpServerFactory;
  dir?: string;
}): Promise<DataSocket> {
  // Unix socket paths are limited to about 104 bytes, so keep this short.
  const path = join(
    opts.dir ?? tmpdir(),
    `neko-data-${opts.runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}.sock`,
  );
  await rm(path, { force: true });

  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    // Stateless mode: one MCP server and transport per request.
    const mcp = opts.buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void mcp.instance.close?.();
    });
    mcp.instance
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((err: unknown) => {
        if (res.headersSent) return;
        res.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : String(err),
            },
          }),
        );
      });
  });
  // Large result sets can take minutes to page through the broker.
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(path, 0o600);

  return {
    path,
    close: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await rm(path, { force: true });
    },
  };
}
