"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { adminApi } from "@/components/admin/admin-api";
import { ActionGroup } from "@/components/ui/action-group";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldInput } from "@/components/ui/field";
import { TargetListEditor } from "@/components/admin/TargetListEditor";
import type { PluginCatalogItem, PluginSettings } from "@/lib/plugin-admin";

type ApprovedList = { kind: string; pluginName: string; as: "value" | "email_domain"; patterns: string[] };

type Notice = { tone: "ok" | "error"; text: string } | null;

export default function PluginSettingsPanel() {
  const [plugins, setPlugins] = useState<PluginSettings[] | null>(null);
  const [approved, setApproved] = useState<ApprovedList[]>([]);
  const [catalog, setCatalog] = useState<PluginCatalogItem[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    const [settings, available, lists] = await Promise.all([
      adminApi<{ plugins: PluginSettings[] }>("/api/admin/plugins/settings"),
      adminApi<{ available: PluginCatalogItem[]; error?: string }>("/api/admin/plugins/catalog"),
      adminApi<{ lists: ApprovedList[] }>("/api/admin/plugins/approved-targets"),
    ]);
    if (lists.ok) setApproved(lists.body.lists);
    if (settings.ok) {
      setPlugins(settings.body.plugins);
      setLoadError(null);
    } else {
      setLoadError(settings.error);
    }
    if (available.ok) {
      setCatalog(available.body.available);
      setCatalogError(available.body.error ?? null);
    } else {
      setCatalogError(available.error);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(initial);
  }, [load]);

  const install = async (item: PluginCatalogItem) => {
    setInstalling(item.name);
    setNotice(null);
    const result = await adminApi<{ envMissing: string[] }>("/api/admin/plugins/install", "POST", { name: item.name });
    setInstalling(null);
    if (!result.ok) {
      setNotice({ tone: "error", text: `Could not install ${item.title}: ${result.error}` });
      return;
    }
    setNotice({
      tone: "ok",
      text:
        result.body.envMissing.length > 0
          ? `Installed ${item.title}. Enter its settings below to use it.`
          : `Installed ${item.title}. It is ready to use.`,
    });
    await load();
  };

  return (
    <>
      <section className="settings-card">
        <div className="settings-card-head">
          <div className="min-w-0">
            <h2 className="settings-card-title">Plugin settings</h2>
            <p className="settings-card-copy">
              Enter the values each plugin needs. OpenNeko stores secrets
              encrypted and never shows them again.
            </p>
          </div>
        </div>
        {loadError ? (
          <p className="border-t border-border py-5 text-sm text-danger">Could not load plugin settings: {loadError}</p>
        ) : plugins === null ? (
          <p className="border-t border-border py-5 text-sm text-text3">Loading plugin settings…</p>
        ) : plugins.length === 0 ? (
          <p className="border-t border-border py-5 text-sm text-text3">No plugins are installed.</p>
        ) : (
          <div className="border-t border-border">
            {plugins.map((plugin) => (
              <div key={plugin.name} className="border-b border-border py-5 last:border-b-0">
                <PluginSettingsForm key={formKey(plugin)} plugin={plugin} onSaved={load} />
                {plugin.targetActions.map((action) => {
                  const list = approved.find((l) => l.kind === action.kind);
                  const email = action.as === "email_domain";
                  return (
                    <div key={action.kind} className="mt-5 border-t border-border pt-5">
                      <TargetListEditor
                        label={`Run ${action.kind} without approval for these ${email ? "recipient domains" : "targets"}`}
                        hint={
                          email
                            ? "One domain per line. An email goes out without approval only when every recipient is on this list; any other email waits for approval. Use *.acme.com for subdomains."
                            : "One target per line. The action runs without approval only when every target is on this list; any other target waits for approval. End a line with * to match a prefix."
                        }
                        placeholder={email ? "acme.com\npartner.com" : "https://hooks.acme.com/*"}
                        patterns={list?.patterns ?? []}
                        onSave={async (text) => {
                          const result = await adminApi("/api/admin/plugins/approved-targets", "POST", {
                            kind: action.kind,
                            patterns: text,
                          });
                          return result.ok ? { ok: true } : { ok: false, error: result.error };
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="settings-card">
        <div className="settings-card-head">
          <div className="min-w-0">
            <h2 className="settings-card-title">Add a plugin</h2>
            <p className="settings-card-copy">
              Plugins from the official OpenNeko marketplace. Each one runs in
              its own sandbox and reaches only the hosts it declares.
            </p>
          </div>
        </div>
        {catalogError ? <p className="mb-4 text-sm text-danger">{catalogError}</p> : null}
        {notice ? (
          <p role="status" className={`mb-4 text-sm ${notice.tone === "error" ? "text-danger" : "text-text2"}`}>
            {notice.text}
          </p>
        ) : null}
        {catalog === null ? (
          <p className="border-t border-border py-5 text-sm text-text3">Loading the marketplace…</p>
        ) : catalog.length === 0 ? (
          <p className="border-t border-border py-5 text-sm text-text3">Every marketplace plugin is installed.</p>
        ) : (
          <ul className="m-0 list-none border-t border-border p-0">
            {catalog.map((item) => (
              <li
                key={item.name}
                className="grid gap-3 border-b border-border py-4 last:border-b-0 md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-6"
              >
                <div className="min-w-0">
                  <div className="font-display text-base font-bold text-text">{item.title}</div>
                  <div className="mt-0.5 font-mono text-xs text-text3">
                    {item.name} · {item.version}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-text2">{item.description}</p>
                </div>
                <Button
                  variant="secondary"
                  disabled={installing !== null}
                  onClick={() => void install(item)}
                >
                  {installing === item.name ? "Installing…" : "Install"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** A new key after a save remounts the form, so it shows the stored state. */
function formKey(plugin: PluginSettings): string {
  return `${plugin.name}:${plugin.fields.map((f) => `${f.key}=${f.set ? (f.value ?? "*") : ""}`).join("|")}`;
}

function PluginSettingsForm({ plugin, onSaved }: { plugin: PluginSettings; onSaved: () => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(plugin.fields.map((f) => [f.key, f.secret ? "" : (f.value ?? "")])),
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Notice>(null);

  const changes: Record<string, string | null> = {};
  for (const field of plugin.fields) {
    const next = (values[field.key] ?? "").trim();
    if (field.secret) {
      if (next) changes[field.key] = next;
    } else if (next !== (field.value ?? "")) {
      if (next) changes[field.key] = next;
      else if (!field.required && field.set) changes[field.key] = null;
    }
  }
  const changed = Object.keys(changes).length > 0;

  const save = async (next: Record<string, string | null>) => {
    setBusy(true);
    setStatus(null);
    const result = await adminApi("/api/admin/plugins/settings", "POST", { plugin: plugin.name, values: next });
    setBusy(false);
    if (!result.ok) {
      setStatus({ tone: "error", text: result.error });
      return;
    }
    setStatus({ tone: "ok", text: "Saved" });
    await onSaved();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (changed) void save(changes);
  };

  return (
    <form onSubmit={submit}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h3 className="font-mono text-sm font-semibold text-text">{plugin.name}</h3>
        <span className="text-xs tabular-nums text-text3">{plugin.version}</span>
        {plugin.missing.length > 0 ? (
          <Badge variant="watch">Needs {plugin.missing.length} {plugin.missing.length === 1 ? "setting" : "settings"}</Badge>
        ) : (
          <Badge variant="success">Ready</Badge>
        )}
      </div>
      {plugin.fields.length === 0 ? (
        <p className="text-sm text-text3">This plugin has no settings.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {plugin.fields.map((field) => (
            <div key={field.key} className="grid min-w-0 content-start gap-2">
              <FieldInput
                label={`${field.key}${field.required ? "" : " (optional)"}`}
                hint={field.description}
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                value={values[field.key] ?? ""}
                placeholder={field.secret ? (field.set ? "Stored. Enter a new value to replace it." : "Not set") : ""}
                onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
              />
              {field.secret && field.set && !field.required ? (
                <div>
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void save({ [field.key]: null })}>
                    Remove stored value
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {plugin.fields.length > 0 ? (
        <ActionGroup className="mt-4">
          <Button type="submit" variant="primary" disabled={busy || !changed}>
            {busy ? "Saving…" : "Save settings"}
          </Button>
          {status ? (
            <span role="status" className={`text-sm ${status.tone === "error" ? "text-danger" : "text-text2"}`}>
              {status.text}
            </span>
          ) : null}
        </ActionGroup>
      ) : null}
    </form>
  );
}
