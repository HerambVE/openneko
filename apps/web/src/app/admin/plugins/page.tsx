import type { ReactNode } from "react";
import { connection } from "next/server";
import { getCurrentActor } from "@/lib/actor";
import { getPluginActionDescriptors, getPluginStatus } from "@/lib/auth";
import { StatCard, StatGrid } from "@/components/ui/stat-card";
import { AdminDenied, AdminShell } from "../AdminShell";
import PluginSettingsPanel from "./PluginSettingsPanel";

export default async function AdminPluginsPage() {
  await connection();
  const actor = await getCurrentActor();
  if (actor.role !== "admin") return <AdminDenied />;

  const [status, descriptors] = await Promise.all([
    getPluginStatus(),
    getPluginActionDescriptors(),
  ]);

  return (
    <AdminShell
      title="Plugin administration"
      subtitle="Install plugins, enter their settings, and check registry health."
      back={{ href: "/admin", label: "Admin" }}
    >
      <StatGrid label="Plugin status">
        <StatCard label="Loaded" value={status.loaded.length} />
        <StatCard
          label="Flagged"
          value={status.flagged.length}
          tone={status.flagged.length > 0 ? "warn" : "neutral"}
        />
        <StatCard label="Plugin action kinds" value={status.kinds.length} />
        <StatCard label="VMs" value={status.vmsRunning} />
      </StatGrid>

      <PluginSettingsPanel />

      <section className="settings-card">
        <div className="settings-card-head">
          <div className="min-w-0">
            <h2 className="settings-card-title">Registry</h2>
            <p className="settings-card-copy">
              The package inventory OpenNeko accepted, skipped, or marked for
              review.
            </p>
          </div>
          <div className="settings-source shrink-0">
            <strong className={status.flagged.length > 0 ? "is-warn" : "is-ok"}>
              {status.flagged.length > 0 ? "Needs review" : "Clean"}
            </strong>
          </div>
        </div>

        <div className="grid border-t border-border md:grid-cols-3">
          <RegistryColumn label="Loaded" values={status.loaded} />
          <RegistryColumn
            label="Skipped"
            values={status.skipped.map(
              (item) => `${item.name}: ${item.reason}`,
            )}
          />
          <RegistryColumn
            label="Flagged"
            values={status.flagged.map(
              (item) => `${item.pluginName}: ${item.reason}`,
            )}
            warn
          />
        </div>
      </section>

      <section className="settings-card">
        <div className="settings-card-head">
          <div className="min-w-0">
            <h2 className="settings-card-title">Capability surface</h2>
            <p className="settings-card-copy">
              Provider entry points and action kinds exposed by installed
              plugins.
            </p>
          </div>
        </div>

        <div className="grid border-y border-border sm:grid-cols-2">
          <Capability
            label="Auth provider"
            values={status.authProvider ? [status.authProvider] : []}
          />
          <Capability
            label="Channels"
            values={status.channels.map(
              (channel) => `${channel.providerLabel} (${channel.pluginId})`,
            )}
          />
        </div>

        <div className="mt-7 flex items-end justify-between gap-4">
          <div>
            <h3 className="font-display text-base font-bold text-text">
              Action descriptors
            </h3>
            <p className="mt-1 text-sm leading-6 text-text2">
              Registered action kinds and their default approval modes.
            </p>
          </div>
          <div className="shrink-0 text-ui-caption tabular-nums text-text3">
            {descriptors.length} action kinds
          </div>
        </div>

        {descriptors.length === 0 ? (
          <div className="mt-4 border-y border-border py-5 text-sm text-text3">
            No plugin actions registered.
          </div>
        ) : (
          <div className="mt-4 border-t border-border">
            <div
              className="hidden grid-cols-[minmax(0,0.9fr)_180px_minmax(0,1.5fr)] gap-5 border-b border-border py-2 text-ui-caption font-semibold text-text2 md:grid"
              aria-hidden="true"
            >
              <div>Kind</div>
              <div>Mode</div>
              <div>Description</div>
            </div>
            {descriptors.map((descriptor) => (
              <div
                key={descriptor.kind}
                className="grid gap-3 border-b border-border py-4 last:border-b-0 md:grid-cols-[minmax(0,0.9fr)_180px_minmax(0,1.5fr)] md:gap-5"
              >
                <DescriptorField label="Kind">
                  <span className="font-mono text-xs font-semibold text-text">
                    {descriptor.kind}
                  </span>
                </DescriptorField>
                <DescriptorField label="Mode">
                  <span className="text-xs font-semibold text-text2">
                    {formatMode(descriptor.default_mode)}
                  </span>
                </DescriptorField>
                <DescriptorField label="Description">
                  <span className="text-sm leading-6 text-text2">
                    {descriptor.description}
                  </span>
                </DescriptorField>
              </div>
            ))}
          </div>
        )}
      </section>
    </AdminShell>
  );
}

function RegistryColumn({
  label,
  values,
  warn = false,
}: {
  label: string;
  values: string[];
  warn?: boolean;
}) {
  return (
    <div className="border-b border-border py-5 last:border-b-0 md:border-b-0 md:border-l md:px-5 md:first:border-l-0 md:first:pl-0 md:last:pr-0">
      <div className="flex items-center justify-between gap-3">
        <h3
          className={`text-ui-caption font-semibold ${
            warn && values.length > 0 ? "text-danger" : "text-text3"
          }`}
        >
          {label}
        </h3>
        <span className="text-xs tabular-nums text-text3">
          {values.length}
        </span>
      </div>
      {values.length === 0 ? (
        <div className="mt-4 text-sm text-text3">
          None
        </div>
      ) : (
        <ul className="m-0 mt-3 list-none border-t border-border p-0">
          {values.map((value) => (
            <li
              key={value}
              className={`border-b border-border py-3 font-mono text-xs leading-5 last:border-b-0 ${
                warn ? "text-danger" : "text-text2"
              }`}
            >
              {value}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Capability({
  label,
  values,
}: {
  label: string;
  values: string[];
}) {
  return (
    <div className="border-b border-border py-4 last:border-b-0 sm:border-b-0 sm:border-l sm:px-5 sm:first:border-l-0 sm:first:pl-0 sm:last:pr-0">
      <div className="text-ui-caption font-semibold text-text3">
        {label}
      </div>
      <div className="mt-2 text-sm font-semibold leading-6 text-text">
        {values.length > 0 ? values.join(", ") : "Not installed"}
      </div>
    </div>
  );
}

function DescriptorField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-ui-caption font-semibold text-text3 md:hidden">
        {label}
      </div>
      {children}
    </div>
  );
}

function formatMode(
  mode:
    | "auto"
    | "ask"
    | "deny"
    | { external?: "auto" | "ask" | "deny"; internal?: "auto" | "ask" | "deny" }
    | undefined,
): string {
  if (!mode) return "default";
  if (typeof mode === "string") return mode;
  return `external ${mode.external ?? "default"} · internal ${mode.internal ?? "default"}`;
}
