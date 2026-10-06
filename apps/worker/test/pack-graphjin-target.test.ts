import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const graphjinQuery = vi.fn();
vi.mock("@neko/llm/graphjin", () => ({
  graphjinQuery: (...args: unknown[]) => graphjinQuery(...args),
  mintGraphjinToken: () => "token",
}));

const { resolveGraphjinTarget } = await import("../src/packs/graphjin-target.js");

describe("pack GraphJin target", () => {
  beforeEach(() => graphjinQuery.mockReset());

  it("uses the GraphJin API when GraphJin keeps its own config", async () => {
    graphjinQuery.mockResolvedValue({ data: { gj_config: { serv: { production: false, auth: { type: "jwt" } } } } });
    await expect(resolveGraphjinTarget({ endpoint: "http://gj:8080", orgId: "org", configFile: "/nowhere/agentic.yml" }))
      .resolves.toEqual({ mode: "api", endpoint: "http://gj:8080", orgId: "org", anonymous: false });
  });

  it("marks a GraphJin without auth as anonymous", async () => {
    graphjinQuery.mockResolvedValue({ data: { gj_config: { serv: JSON.stringify({ production: false, auth: { type: "none" } }) } } });
    await expect(resolveGraphjinTarget({ endpoint: "http://gj:8080", orgId: "org" }))
      .resolves.toMatchObject({ mode: "api", anonymous: true });
  });

  it("writes the shared config folder for a production GraphJin that OpenNeko manages", async () => {
    const configFile = join(await mkdtemp(join(tmpdir(), "gj-")), "agentic.yml");
    await writeFile(configFile, "sources: []\n");
    graphjinQuery.mockResolvedValue({ data: { gj_config: [{ serv: { production: true } }] } });
    await expect(resolveGraphjinTarget({ endpoint: "http://gj:8080", orgId: "org", configFile }))
      .resolves.toEqual({ mode: "files", endpoint: "http://gj:8080", orgId: "org", configFile });
  });

  it("explains a production GraphJin that OpenNeko cannot configure", async () => {
    graphjinQuery.mockResolvedValue({ data: { gj_config: { serv: { production: true } } } });
    await expect(resolveGraphjinTarget({ endpoint: "http://gj:8080", orgId: "org" }))
      .rejects.toThrow("runs in production mode");
  });

  it("explains a GraphJin whose config OpenNeko cannot read", async () => {
    graphjinQuery.mockResolvedValue({ errors: [{ message: "gj_config root is blocked" }] });
    await expect(resolveGraphjinTarget({ endpoint: "http://gj:8080", orgId: "org" }))
      .rejects.toThrow("Allow config.read and gj_config access for OpenNeko");
  });
});
