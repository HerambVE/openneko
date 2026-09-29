import { NextResponse } from "next/server";
import { isDenied, requireAdminActor } from "@/lib/admin-auth";

export type PluginSettingField = {
  key: string;
  required: boolean;
  secret: boolean;
  description: string;
  set: boolean;
  value?: string;
};

export type PluginSettings = {
  name: string;
  version: string;
  fields: PluginSettingField[];
  missing: string[];
  targetActions: Array<{ kind: string; description: string; as: "value" | "email_domain" }>;
};

export type PluginCatalogItem = {
  name: string;
  title: string;
  description: string;
  version: string;
};

function workerAdminBase(): string {
  return (process.env.WORKER_ADMIN_URL ?? "http://127.0.0.1:4100").replace(/\/+$/, "");
}

/** Calls the worker's plugin admin routes. Secret values go to the worker and never come back. */
export async function requestPluginWorker(
  path: "/admin/plugins/settings" | "/admin/plugins/catalog" | "/admin/plugins/install",
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${workerAdminBase()}${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(path === "/admin/plugins/install" ? 300_000 : 30_000),
  });
  const body = await response.json().catch(() => ({ error: `Worker returned HTTP ${response.status}` }));
  return { status: response.status, body };
}

export async function proxyPluginAdmin(
  path: Parameters<typeof requestPluginWorker>[0],
  request?: Request,
): Promise<NextResponse> {
  const allowed = await requireAdminActor();
  if (isDenied(allowed)) return allowed;
  try {
    const result = await requestPluginWorker(
      path,
      request ? { method: "POST", headers: { "Content-Type": "application/json" }, body: await request.text() } : {},
    );
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
