import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createAdminHandler, type PluginsHandlerSurface } from "../src/admin-server";

async function withServer(plugins: PluginsHandlerSurface, fn: (base: string) => Promise<void>) {
  const server = createServer(createAdminHandler({ plugins }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function surface(overrides: Partial<PluginsHandlerSurface> = {}): PluginsHandlerSurface {
  return {
    status: () => ({ loaded: [], skipped: [], flagged: [], kinds: [], vmsRunning: 0, authProvider: null, directoryProvider: null, channels: [] }),
    getRegisteredActionDescriptors: () => [],
    ...overrides,
  } as PluginsHandlerSurface;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("plugin settings admin routes", () => {
  it("lists settings from the registry", async () => {
    const settings = vi.fn(() => [
      { name: "@open-neko/plugin-resend", version: "0.2.0", fields: [], missing: ["RESEND_API_KEY"] },
    ]);
    await withServer(surface({ settings }), async (base) => {
      const res = await fetch(`${base}/admin/plugins/settings`);
      expect(res.status).toBe(200);
      expect((await res.json()).plugins[0].missing).toEqual(["RESEND_API_KEY"]);
    });
  });

  it("saves values and rejects bad input before the registry", async () => {
    const setSettings = vi.fn(async () => {});
    await withServer(surface({ setSettings }), async (base) => {
      const ok = await post(`${base}/admin/plugins/settings`, {
        plugin: "@open-neko/plugin-resend",
        values: { RESEND_FROM: "Ops <ops@acme.com>", RESEND_LOGO_URL: null },
      });
      expect(ok.status).toBe(200);
      expect(setSettings).toHaveBeenCalledWith("@open-neko/plugin-resend", {
        RESEND_FROM: "Ops <ops@acme.com>",
        RESEND_LOGO_URL: null,
      });

      expect((await post(`${base}/admin/plugins/settings`, { plugin: "../etc", values: { A: "b" } })).status).toBe(400);
      expect((await post(`${base}/admin/plugins/settings`, { plugin: "x", values: { A: 3 } })).status).toBe(400);
      expect((await post(`${base}/admin/plugins/settings`, { plugin: "x", values: {} })).status).toBe(400);
      expect(setSettings).toHaveBeenCalledOnce();
    });
  });

  it("returns 400 for a registry settings error", async () => {
    const error = Object.assign(new Error("RESEND_API_KEY is required and cannot be cleared"), { name: "PluginSettingsError" });
    const setSettings = vi.fn(async () => {
      throw error;
    });
    await withServer(surface({ setSettings }), async (base) => {
      const res = await post(`${base}/admin/plugins/settings`, { plugin: "x", values: { RESEND_API_KEY: null } });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/cannot be cleared/);
    });
  });

  it("installs by package name only", async () => {
    const install = vi.fn(async (name: string) => ({ name, version: "0.2.0", envMissing: ["RESEND_API_KEY"] }));
    await withServer(surface({ install }), async (base) => {
      const res = await post(`${base}/admin/plugins/install`, { name: "@open-neko/plugin-resend" });
      expect(await res.json()).toEqual({ name: "@open-neko/plugin-resend", version: "0.2.0", envMissing: ["RESEND_API_KEY"] });
      expect((await post(`${base}/admin/plugins/install`, { name: "https://github.com/x/y" })).status).toBe(400);
      expect(install).toHaveBeenCalledOnce();
    });
  });
});
