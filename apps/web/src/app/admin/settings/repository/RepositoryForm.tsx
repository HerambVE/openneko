"use client";

import { useState } from "react";
import { toast } from "sonner";
import Link from "next/link";
import type {
  ContextRemoteKind,
  ContextRemoteMode,
  ContextRemoteSettings,
  PublishResult,
  RemoteUpdates,
  UpdateChoices,
} from "@neko/llm/config-vcs";
import { AdminError } from "@/components/admin/AdminError";
import { adminApi } from "@/components/admin/admin-api";
import AppHeader from "@/components/AppHeader";
import CreatorCredit from "@/components/CreatorCredit";
import PageHeading from "@/components/PageHeading";
import SectionNav from "@/components/SectionNav";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, Input, NativeSelect } from "@/components/ui/field";

const KINDS: Array<{ kind: ContextRemoteKind; label: string; private?: boolean }> = [
  { kind: "skills", label: "Skills" },
  { kind: "skill-overlays", label: "Skill learnings" },
  { kind: "workflows", label: "Workflows" },
  { kind: "memory", label: "Memories", private: true },
  { kind: "library", label: "Library concepts", private: true },
];

type Draft = { url: string; mode: ContextRemoteMode; branch: string; kinds: ContextRemoteKind[]; username: string; token: string };

function toDraft(remote: ContextRemoteSettings | null): Draft {
  return {
    url: remote?.url ?? "",
    mode: remote?.mode ?? "pull_request",
    branch: remote?.branch ?? "main",
    kinds: remote?.kinds ?? ["skills", "skill-overlays", "workflows"],
    username: remote?.username ?? "",
    token: "",
  };
}

export default function RepositoryForm({ initial }: { initial: ContextRemoteSettings | null }) {
  const [remote, setRemote] = useState(initial);
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [busy, setBusy] = useState<"save" | "publish" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy("save");
    setError(null);
    const { token, ...rest } = draft;
    const result = await adminApi<{ remote: ContextRemoteSettings }>("/api/admin/context-remote", "PUT", {
      ...rest,
      ...(token.trim() ? { token } : {}),
    });
    setBusy(null);
    if (!result.ok) return setError(result.error);
    setRemote(result.body.remote);
    setDraft(toDraft(result.body.remote));
    toast.success("Repository saved.");
  }

  async function publish() {
    setBusy("publish");
    setError(null);
    const result = await adminApi<{ result: PublishResult; remote: ContextRemoteSettings }>("/api/admin/context-remote/publish", "POST");
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      const refreshed = await adminApi<{ remote: ContextRemoteSettings | null }>("/api/admin/context-remote");
      if (refreshed.ok) setRemote(refreshed.body.remote);
      return;
    }
    setRemote(result.body.remote);
    toast.success(result.body.result.detail);
  }

  async function disconnect() {
    setBusy("remove");
    setError(null);
    const result = await adminApi<{ remote: null }>("/api/admin/context-remote", "DELETE");
    setBusy(null);
    if (!result.ok) return setError(result.error);
    setRemote(null);
    setDraft(toDraft(null));
    toast.success("Repository disconnected.");
  }

  const toggle = (kind: ContextRemoteKind, on: boolean) =>
    setDraft((d) => ({ ...d, kinds: on ? [...d.kinds, kind] : d.kinds.filter((k) => k !== kind) }));

  return (
    <>
      <div className="root">
        <AppHeader back={{ href: "/admin/settings", label: "Settings" }}>
          <SectionNav current="admin" />
        </AppHeader>

        <PageHeading
          title="Context repository"
          description="OpenNeko keeps a git history of the company's skills, workflows and other context. Publish it to a repository on GitHub, GitLab or another git host."
        />

        {remote ? (
          <section className="settings-card mb-6 flex flex-col gap-3" aria-label="Publishing">
            <div className="flex items-start justify-between gap-4 max-[720px]:flex-col">
              <div className="flex flex-col gap-1">
                <h2 className="settings-card-title">Publish</h2>
                <p className="settings-card-copy">
                  {remote.mode === "push"
                    ? `Pushes the company version to ${remote.branch}.`
                    : `Opens a pull request against ${remote.branch}.`}{" "}
                  OpenNeko replaces only the folders it publishes. Other files in the repository stay as they are.
                </p>
                {remote.lastPublish ? (
                  <p className={`text-ui-body-sm ${remote.lastPublish.status === "ok" ? "text-text2" : "text-danger"}`}>
                    {remote.lastPublish.at.slice(0, 16).replace("T", " ")} UTC · {remote.lastPublish.detail}{" "}
                    {remote.lastPublish.link ? (
                      <a className="underline" href={remote.lastPublish.link} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    ) : null}
                  </p>
                ) : null}
              </div>
              <Button type="button" variant="primary" disabled={busy !== null} onClick={() => void publish()}>
                {busy === "publish" ? "Publishing…" : remote.mode === "push" ? "Push now" : "Open pull request"}
              </Button>
            </div>
          </section>
        ) : null}

        {remote ? <Updates /> : null}

        <form onSubmit={save} className="settings-card flex flex-col gap-5">
          <div>
            <h2 className="settings-card-title">Remote repository</h2>
            <p className="settings-card-copy">
              Use an empty repository, or one where OpenNeko may own the folders you choose below. Personal changes are never published.
            </p>
          </div>
          <AdminError message={error} />
          <div className="grid grid-cols-2 gap-4 max-[720px]:grid-cols-1">
            <Field label="Repository address" htmlFor="repo-url" hint="The HTTPS address, such as https://github.com/acme/openneko-context.git.">
              <Input
                id="repo-url"
                type="url"
                required
                value={draft.url}
                onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
              />
            </Field>
            <Field label="Branch" htmlFor="repo-branch" hint="The branch OpenNeko pushes to, or opens pull requests against.">
              <Input
                id="repo-branch"
                required
                value={draft.branch}
                onChange={(e) => setDraft((d) => ({ ...d, branch: e.target.value }))}
              />
            </Field>
            <Field
              label="Access token"
              htmlFor="repo-token"
              hint={remote?.hasToken
                ? "A token is saved. Enter a new one to replace it."
                : "A token that can write to the repository and open pull requests. OpenNeko stores it encrypted."}
            >
              <Input
                id="repo-token"
                type="password"
                autoComplete="off"
                value={draft.token}
                onChange={(e) => setDraft((d) => ({ ...d, token: e.target.value }))}
              />
            </Field>
            <Field label="Username" htmlFor="repo-username" hint="Leave blank for GitHub and GitLab. Some hosts need the account name for the token.">
              <Input
                id="repo-username"
                autoComplete="off"
                value={draft.username}
                onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))}
              />
            </Field>
            <Field label="How to publish" htmlFor="repo-mode" hint="A pull request lets someone review the change on the git host first.">
              <NativeSelect
                id="repo-mode"
                value={draft.mode}
                onChange={(e) => setDraft((d) => ({ ...d, mode: e.target.value as ContextRemoteMode }))}
              >
                <option value="pull_request">Open a pull request</option>
                <option value="push">Push to the branch</option>
              </NativeSelect>
            </Field>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-ui-body-sm text-text">What to publish</legend>
            {KINDS.map(({ kind, label, private: sensitive }) => (
              <div key={kind} className="grid gap-1">
                <Checkbox
                  label={label}
                  checked={draft.kinds.includes(kind)}
                  onCheckedChange={(checked) => toggle(kind, checked === true)}
                />
                {sensitive ? (
                  <p className="pl-6 text-ui-caption text-text3">Holds business facts. Publish it only to a private repository.</p>
                ) : null}
              </div>
            ))}
          </fieldset>
          <div className="flex justify-end gap-2">
            {remote ? (
              <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void disconnect()}>
                {busy === "remove" ? "Disconnecting…" : "Disconnect"}
              </Button>
            ) : null}
            <Button type="submit" variant="primary" disabled={busy !== null}>
              {busy === "save" ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </div>

      <CreatorCredit />
    </>
  );
}

function Updates() {
  const [updates, setUpdates] = useState<RemoteUpdates | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addedPacks, setAddedPacks] = useState<string[]>([]);

  async function check() {
    setBusy("check");
    setError(null);
    const result = await adminApi<{ updates: RemoteUpdates }>("/api/admin/context-remote/updates");
    setBusy(null);
    if (!result.ok) return setError(result.error);
    setUpdates(result.body.updates);
  }

  async function apply(key: string, choices: UpdateChoices) {
    setBusy(key);
    setError(null);
    const result = await adminApi<{ updates: RemoteUpdates; packs: Array<{ id: string; ok: boolean; error?: string }> }>(
      "/api/admin/context-remote/updates",
      "POST",
      choices,
    );
    setBusy(null);
    if (!result.ok) return setError(result.error);
    setUpdates(result.body.updates);
    const failed = result.body.packs.find((pack) => !pack.ok);
    if (failed) return setError(`Pack ${failed.id} was not added: ${failed.error}`);
    setAddedPacks((ids) => [...ids, ...result.body.packs.map((pack) => pack.id)]);
    toast.success(choices.packs.length ? "Pack added. Install it on the Packs page." : "Skills updated.");
  }

  const nothing = updates && updates.skills.length === 0 && updates.packs.length === 0;
  return (
    <section className="settings-card mb-6 flex flex-col gap-3" aria-label="Updates from the repository">
      <div className="flex items-start justify-between gap-4 max-[720px]:flex-col">
        <div className="flex flex-col gap-1">
          <h2 className="settings-card-title">Updates from the repository</h2>
          <p className="settings-card-copy">Skills and packs that someone changed in the repository. Nothing changes in OpenNeko until you choose.</p>
        </div>
        <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void check()}>
          {busy === "check" ? "Checking…" : "Check for updates"}
        </Button>
      </div>
      <AdminError message={error} />
      {nothing ? <p className="text-ui-body-sm text-text2">OpenNeko has everything in the repository.</p> : null}
      {updates?.skills.length ? (
        <ul className="flex flex-col gap-3">
          {updates.skills.map((skill) => (
            <li key={skill.name} className="flex items-start justify-between gap-4 max-[720px]:flex-col">
              <div className="flex flex-col gap-0.5">
                <span className="text-ui-body-sm text-text">Skill: {skill.name}</span>
                <span className="text-ui-caption text-text3">
                  {skill.status === "update"
                    ? "Changed in the repository."
                    : "Changed in both OpenNeko and the repository. Choose which version to keep."}
                </span>
              </div>
              <div className="flex gap-2">
                {skill.status === "both_changed" ? (
                  <Button type="button" size="sm" variant="secondary" disabled={busy !== null}
                    onClick={() => void apply(skill.name, { skills: [{ name: skill.name, choice: "local" }], packs: [] })}>
                    Keep OpenNeko&apos;s
                  </Button>
                ) : null}
                <Button type="button" size="sm" variant="primary" disabled={busy !== null}
                  onClick={() => void apply(skill.name, { skills: [{ name: skill.name, choice: "remote" }], packs: [] })}>
                  {skill.status === "update" ? "Bring in" : "Use the repository's"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {updates?.packs.length ? (
        <ul className="flex flex-col gap-3">
          {updates.packs.map((pack) => (
            <li key={pack.id} className="flex items-start justify-between gap-4 max-[720px]:flex-col">
              <div className="flex flex-col gap-0.5">
                <span className="text-ui-body-sm text-text">Pack: {pack.id}</span>
                <span className={`text-ui-caption ${pack.status === "invalid" ? "text-danger" : "text-text3"}`}>{pack.detail}</span>
              </div>
              {pack.status === "invalid" ? null : (
                <Button type="button" size="sm" variant="primary" disabled={busy !== null}
                  onClick={() => void apply(pack.id, { skills: [], packs: [pack.id] })}>
                  Add
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {addedPacks.length ? (
        <p className="text-ui-body-sm text-text2">
          Added {addedPacks.join(", ")}. <Link className="underline" href="/admin/settings/packs">Install on the Packs page</Link>
        </p>
      ) : null}
    </section>
  );
}
