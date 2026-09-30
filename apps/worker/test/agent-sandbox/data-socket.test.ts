import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GRAPHJIN_DIRECT_GOVERNED_POLICY,
  buildGraphjinMcpServer,
} from "@neko/llm/sandbox-runtime";
import type { BrokerControlPlane } from "../../src/agent-sandbox/broker-client.js";
import { installDataClient } from "../../src/agent-sandbox/data-client.js";
import { startDataSocket, type DataSocket } from "../../src/agent-sandbox/data-socket.js";

const run = promisify(execFile);

function fakeBroker(payload: unknown) {
  const callGraphjinTool = vi.fn(async () => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  }));
  const controlPlane = {
    listGraphjinTools: vi.fn(async () => []),
    callGraphjinTool,
  } as unknown as BrokerControlPlane;
  return { controlPlane, callGraphjinTool };
}

describe("run data socket", () => {
  let dir: string;
  let socket: DataSocket | undefined;

  afterEach(async () => {
    await socket?.close();
    socket = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function setup(
    payload: unknown,
    toolPolicy?: typeof GRAPHJIN_DIRECT_GOVERNED_POLICY,
  ) {
    dir = await mkdtemp(join(tmpdir(), "neko-data-"));
    const broker = fakeBroker(payload);
    socket = await startDataSocket({
      runId: "run-1234567890abcdef",
      dir,
      buildServer: () =>
        buildGraphjinMcpServer({
          orgId: "org-1",
          runId: "run-1",
          controlPlane: broker.controlPlane,
          ...(toolPolicy ? { toolPolicy } : {}),
        }),
    });
    await installDataClient(join(dir, "bin"));
    const env = {
      ...process.env,
      OPENNEKO_DATA_SOCKET: socket.path,
      PYTHONPATH: join(dir, "bin"),
    };
    return { ...broker, env };
  }

  it("serves a script's query through the run's GraphJin tool", async () => {
    const { callGraphjinTool, env } = await setup({
      data: { orders: [{ id: 1 }, { id: 2 }] },
      next: null,
    });
    expect((await stat(socket!.path)).mode & 0o777).toBe(0o600);

    const { stdout } = await run(
      "python3",
      [
        "-c",
        "import json\nfrom neko_data import query\nprint(json.dumps(query('query { orders { id } }', {'x': 1})))",
      ],
      { env },
    );

    expect(JSON.parse(stdout)).toEqual({ orders: [{ id: 1 }, { id: 2 }] });
    expect(callGraphjinTool).toHaveBeenCalledWith({
      orgId: "org-1",
      runId: "run-1",
      name: "execute_graphql",
      arguments: { query: "query { orders { id } }", variables: { x: 1 } },
    });
  });

  it("unwraps a result wrapper and prints data from neko-query", async () => {
    const { env } = await setup({
      result: JSON.stringify({ data: { leads: [{ email: "a@b.co" }] } }),
    });
    const { stdout } = await run(
      join(dir, "bin", "neko-query"),
      ["query { leads { email } }"],
      { env },
    );
    expect(JSON.parse(stdout)).toEqual({ leads: [{ email: "a@b.co" }] });
  });

  it("fails the script on GraphQL errors", async () => {
    const { env } = await setup({
      data: null,
      errors: [{ message: "invalid query: no selectors found" }],
    });
    const result = await run(
      join(dir, "bin", "neko-query"),
      ["query { __typename }"],
      { env },
    ).catch((err: { code: number; stderr: string }) => err);
    expect(result).toMatchObject({ code: 1 });
    expect((result as { stderr: string }).stderr).toContain("no selectors found");
  });

  it("applies the run's tool policy to script calls", async () => {
    const { callGraphjinTool, env } = await setup(
      { data: {} },
      GRAPHJIN_DIRECT_GOVERNED_POLICY,
    );
    const result = await run(
      "python3",
      ["-c", "from neko_data import call_tool\ncall_tool('execute_saved_query', {'name': 'x'})"],
      { env },
    ).catch((err: { code: number; stderr: string }) => err);
    expect(result).toMatchObject({ code: 1 });
    expect(callGraphjinTool).not.toHaveBeenCalled();
  });

  it("removes the socket file on close", async () => {
    await setup({ data: {} });
    const path = socket!.path;
    await socket!.close();
    socket = undefined;
    await expect(stat(path)).rejects.toThrow();
  });
});
