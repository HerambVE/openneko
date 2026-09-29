import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { callRoute } from "../_helpers/route";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  worker: vi.fn(),
  upsert: vi.fn(),
  getByName: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/admin-auth", () => ({
  requireAdminActor: mocks.admin,
  isDenied: (value: unknown) => value instanceof NextResponse,
}));
vi.mock("@/lib/db", () => ({ getOrgId: async () => "org-1" }));
vi.mock("@/lib/plugin-admin", () => ({ requestPluginWorker: mocks.worker }));
vi.mock("@neko/llm/workflows", () => ({
  upsertActionPolicyByName: mocks.upsert,
  getActionPolicyByName: mocks.getByName,
  getActionPolicy: vi.fn(),
  updateActionPolicy: mocks.update,
}));

const { GET, POST } = await import("@/app/api/admin/plugins/approved-targets/route");
const { PATCH } = await import("@/app/api/policies/[policyId]/route");

const settings = {
  status: 200,
  body: {
    plugins: [
      {
        name: "@open-neko/plugin-resend",
        version: "0.2.0",
        fields: [],
        missing: [],
        targetActions: [{ kind: "send_email", description: "Send.", as: "email_domain" }],
      },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ userId: "u1" });
  mocks.worker.mockResolvedValue(settings);
  mocks.upsert.mockResolvedValue({ action: "created", policy: { id: "rule-1" } });
});

describe("/api/admin/plugins/approved-targets", () => {
  it("saves a domain list as an auto-approve rule that sends misses to the next rule", async () => {
    const res = await callRoute(POST, { method: "POST", body: { kind: "send_email", patterns: "Acme.com\npartner.com" } });
    expect(res.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        name: "Approved targets: send_email",
        appliesToKinds: ["send_email"],
        mode: "auto_approve",
        allowedTargets: { patterns: ["acme.com", "partner.com"], on_miss: "next" },
        enabled: true,
      }),
    );
  });

  it("disables the rule when the list is empty", async () => {
    await callRoute(POST, { method: "POST", body: { kind: "send_email", patterns: "" } });
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("refuses a kind that declares no targets, and a bad domain", async () => {
    expect((await callRoute(POST, { method: "POST", body: { kind: "send_webhook", patterns: "a" } })).status).toBe(400);
    expect((await callRoute(POST, { method: "POST", body: { kind: "send_email", patterns: "ops@acme.com" } })).status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("lists each target action with its enabled rule's patterns", async () => {
    mocks.getByName.mockResolvedValue({ id: "rule-1", enabled: true, allowedTargets: { patterns: ["acme.com"], on_miss: "next" } });
    const res = await callRoute(GET);
    expect(res.body).toEqual({
      lists: [{ kind: "send_email", pluginName: "@open-neko/plugin-resend", as: "email_domain", patterns: ["acme.com"], ruleId: "rule-1" }],
    });
  });

  it("stops a non-admin", async () => {
    mocks.admin.mockResolvedValue(NextResponse.json({ error: "admin only" }, { status: 403 }));
    expect((await callRoute(POST, { method: "POST", body: { kind: "send_email", patterns: "a.com" } })).status).toBe(403);
  });
});

describe("PATCH /api/policies/[id] allowedTargets", () => {
  const patch = (body: unknown) =>
    PATCH(new Request("http://localhost/api/policies/p1", { method: "PATCH", body: JSON.stringify(body) }), {
      params: Promise.resolve({ policyId: "p1" }),
    });

  it("writes the list with the miss choice", async () => {
    mocks.update.mockResolvedValue({ id: "p1", approverGroupId: null, allowedTargets: { patterns: ["a.com"], on_miss: "next" } });
    const res = await patch({ allowedTargets: { patterns: "a.com", onMiss: "next" } });
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith("org-1", "p1", { allowedTargets: { patterns: ["a.com"], on_miss: "next" } });

    await patch({ allowedTargets: { patterns: "a.com", onMiss: "deny" } });
    expect(mocks.update).toHaveBeenLastCalledWith("org-1", "p1", { allowedTargets: { patterns: ["a.com"] } });

    await patch({ allowedTargets: { patterns: "", onMiss: "deny" } });
    expect(mocks.update).toHaveBeenLastCalledWith("org-1", "p1", { allowedTargets: null });
  });

  it("rejects a bad miss choice and an empty body", async () => {
    expect((await patch({ allowedTargets: { patterns: "a.com", onMiss: "maybe" } })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
