import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "./git-shell";
import { withRepoLock } from "./lock";

export const CONTEXT_REMOTE_KINDS = ["skills", "skill-overlays", "workflows", "memory", "library"] as const;
export type ContextRemoteKind = (typeof CONTEXT_REMOTE_KINDS)[number];
export const DEFAULT_CONTEXT_REMOTE_KINDS: ContextRemoteKind[] = ["skills", "skill-overlays", "workflows"];

export type ContextRemoteMode = "push" | "pull_request";
export type ContextRemoteProvider = "github" | "gitlab" | "other";

export type PublishResult = {
  status: "pushed" | "pull_request" | "unchanged";
  branch: string;
  sha: string | null;
  link: string | null;
  detail: string;
};

export class ContextRemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextRemoteError";
  }
}

/** An HTTPS git URL with no credentials, query or fragment. Tests may use a file URL. */
export function parseRemoteUrl(value: string, options: { allowFile?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ContextRemoteError("Enter the repository's HTTPS address, such as https://github.com/acme/openneko-context.git.");
  }
  if (url.protocol === "file:" && options.allowFile) return url;
  if (url.protocol !== "https:") throw new ContextRemoteError("The repository address must start with https://.");
  if (url.username || url.password) throw new ContextRemoteError("Put the access token in the token field, not in the address.");
  if (url.search || url.hash || url.pathname.split("/").filter(Boolean).length < 2) {
    throw new ContextRemoteError("The address must name a repository, such as https://github.com/acme/openneko-context.git.");
  }
  return url;
}

export function remoteProvider(url: URL): ContextRemoteProvider {
  if (url.hostname === "github.com") return "github";
  if (url.hostname === "gitlab.com" || url.hostname.startsWith("gitlab.")) return "gitlab";
  return "other";
}

export function validBranchName(branch: string): boolean {
  return /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/.test(branch) && !branch.includes("..") && !branch.endsWith("/") && !branch.endsWith(".lock");
}

function repositoryPath(url: URL): string {
  return url.pathname.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
}

/** Git reads the credential from its environment, so it never appears in an argument or error. */
function authEnv(url: URL, token: string | undefined, username: string | undefined): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" };
  if (!token) return env;
  const user = username || (remoteProvider(url) === "gitlab" ? "oauth2" : "x-access-token");
  return {
    ...env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`,
  };
}

function scrub(message: string, token: string | undefined): string {
  if (!token) return message;
  return message.split(token).join("***").split(Buffer.from(token).toString("base64")).join("***");
}

/**
 * The remote tree with each published folder replaced by OpenNeko's copy.
 * Files outside those folders, such as a README or CI config, stay as they are.
 */
async function publishTree(root: string, head: string, base: string | null, kinds: readonly ContextRemoteKind[]): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "neko-export-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  try {
    const published = (line: string) => kinds.some((kind) => line.split("\t")[1]?.startsWith(`${kind}/`));
    const kept = base
      ? (await git(root, ["ls-tree", "-r", "--full-tree", base])).stdout.split("\n").filter((line) => line && !published(line))
      : [];
    const ours = (await git(root, ["ls-tree", "-r", "--full-tree", head, "--", ...kinds])).stdout.split("\n").filter(Boolean);
    await git(root, ["read-tree", "--empty"], { env });
    const entries = [...kept, ...ours];
    if (entries.length) await git(root, ["update-index", "--index-info"], { env, input: `${entries.join("\n")}\n` });
    return (await git(root, ["write-tree"], { env })).stdout.trim();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function openPullRequest(opts: {
  url: URL;
  token: string | undefined;
  head: string;
  base: string;
  title: string;
  body: string;
  fetchImpl: typeof fetch;
}): Promise<string | null> {
  const provider = remoteProvider(opts.url);
  if (!opts.token || provider === "other") return null;
  const path = repositoryPath(opts.url);
  const response = provider === "github"
    ? await opts.fetchImpl(`https://api.github.com/repos/${path}/pulls`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "OpenNeko",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: opts.title, head: opts.head, base: opts.base, body: opts.body }),
      })
    : await opts.fetchImpl(`https://${opts.url.host}/api/v4/projects/${encodeURIComponent(path)}/merge_requests`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: opts.title, source_branch: opts.head, target_branch: opts.base, description: opts.body }),
      });
  const payload = (await response.json().catch(() => ({}))) as { html_url?: string; web_url?: string; message?: string };
  if (!response.ok) {
    throw new ContextRemoteError(
      `The branch was pushed, but ${provider === "github" ? "GitHub" : "GitLab"} did not open the request (${response.status}${payload.message ? `: ${payload.message}` : ""}).`,
    );
  }
  return payload.html_url ?? payload.web_url ?? null;
}

/**
 * Publish the chosen kinds from the org's main context to a remote branch.
 * The new commit's parent is the remote branch tip, so a push is a normal
 * fast-forward and a pull request shows exactly what OpenNeko changed.
 */
export async function publishContext(opts: {
  orgRoot: string;
  url: URL;
  token?: string;
  username?: string;
  mode: ContextRemoteMode;
  branch: string;
  kinds: readonly ContextRemoteKind[];
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<PublishResult> {
  const root = resolve(opts.orgRoot);
  const env = authEnv(opts.url, opts.token, opts.username);
  const remote = opts.url.toString();
  const run = (args: string[]) => git(root, args, { env }).catch((error: Error) => {
    throw new ContextRemoteError(scrub(error.message, opts.token));
  });

  return withRepoLock(root, async () => {
    const head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();
    if (!head) throw new ContextRemoteError("There is nothing to publish yet.");

    const tracking = `refs/openneko/remote/${opts.branch}`;
    let base: string | null = null;
    try {
      await run(["fetch", "--no-tags", "--quiet", remote, `+refs/heads/${opts.branch}:${tracking}`]);
      base = (await git(root, ["rev-parse", tracking])).stdout.trim();
    } catch (error) {
      if (!/couldn't find remote ref/i.test((error as Error).message)) throw error;
    }

    const tree = await publishTree(root, head, base, opts.kinds);
    if (base && (await git(root, ["rev-parse", `${base}^{tree}`])).stdout.trim() === tree) {
      return { status: "unchanged", branch: opts.branch, sha: base, link: null, detail: "The remote already has this version." };
    }
    const title = "Update OpenNeko context";
    const body = `Published from OpenNeko version ${head.slice(0, 12)}: ${opts.kinds.join(", ")}.`;
    const sha = (await git(root, ["commit-tree", tree, ...(base ? ["-p", base] : []), "-m", title, "-m", body])).stdout.trim();

    if (opts.mode === "push" || !base) {
      await run(["push", "--quiet", remote, `${sha}:refs/heads/${opts.branch}`]).catch((error: Error) => {
        throw /non-fast-forward|fetch first|rejected/i.test(error.message)
          ? new ContextRemoteError("The remote branch changed while OpenNeko was publishing. Publish again.")
          : error;
      });
      await git(root, ["update-ref", tracking, sha]);
      return {
        status: "pushed",
        branch: opts.branch,
        sha,
        link: remoteProvider(opts.url) === "github" ? `https://github.com/${repositoryPath(opts.url)}/tree/${opts.branch}` : null,
        detail: base ? `Pushed to ${opts.branch}.` : `Created ${opts.branch} on the remote.`,
      };
    }

    const stamp = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const head_branch = `openneko/context-${stamp}`;
    await run(["push", "--quiet", remote, `${sha}:refs/heads/${head_branch}`]);
    const link = await openPullRequest({
      url: opts.url,
      token: opts.token,
      head: head_branch,
      base: opts.branch,
      title,
      body,
      fetchImpl: opts.fetchImpl ?? fetch,
    });
    return {
      status: "pull_request",
      branch: head_branch,
      sha,
      link,
      detail: link
        ? `Opened a request to merge ${head_branch} into ${opts.branch}.`
        : `Pushed ${head_branch}. Open a request to merge it into ${opts.branch} on your git host.`,
    };
  });
}

export type SkillUpdate = {
  name: string;
  status: "update" | "both_changed";
  remoteTree: string;
};

export type PackUpdate = {
  id: string;
  version: string | null;
  status: "new_pack" | "new_version" | "invalid";
  detail: string;
};

export type RemoteUpdates = {
  tip: string | null;
  skills: SkillUpdate[];
  packs: PackUpdate[];
};

/** Tree id of each top-level folder under `prefix` at `ref`. */
async function folderTrees(root: string, ref: string, prefix: string): Promise<Map<string, string>> {
  const { stdout } = await git(root, ["ls-tree", ref, "--", `${prefix}/`]).catch(() => ({ stdout: "" }));
  const trees = new Map<string, string>();
  for (const line of stdout.split("\n").filter(Boolean)) {
    const [meta, path] = line.split("\t");
    const [, type, sha] = meta!.split(" ");
    if (type === "tree" && path) trees.set(path.slice(prefix.length + 1), sha!);
  }
  return trees;
}

/** Fetch the remote branch into `refs/openneko/remote/<branch>`. Returns its tip, or null when the branch is missing. */
async function fetchRemote(root: string, url: URL, branch: string, token?: string, username?: string): Promise<string | null> {
  const tracking = `refs/openneko/remote/${branch}`;
  try {
    await git(root, ["fetch", "--no-tags", "--quiet", url.toString(), `+refs/heads/${branch}:${tracking}`], { env: authEnv(url, token, username) });
  } catch (error) {
    if (/couldn't find remote ref/i.test((error as Error).message)) return null;
    throw new ContextRemoteError(scrub((error as Error).message, token));
  }
  return (await git(root, ["rev-parse", tracking])).stdout.trim();
}

/** The ZIP the pack uploader accepts: one top-level folder named after the pack. */
export async function remotePackArchive(orgRoot: string, tip: string, id: string): Promise<Buffer> {
  const root = resolve(orgRoot);
  const { execFile } = await import("node:child_process");
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["archive", "--format=zip", `--prefix=${id}/`, `${tip}:packs/${id}`],
      { cwd: root, encoding: "buffer", maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } },
      (error, stdout) => (error ? reject(new ContextRemoteError(`Could not package pack ${id}.`)) : resolvePromise(stdout)),
    );
  });
}

/**
 * Compare the remote branch with OpenNeko's skills and packs.
 * `skillBases` holds each skill's tree at its last sync with this remote.
 * `uploadedPacks` maps a pack id to its uploaded versions and their content hashes.
 */
export async function checkRemoteUpdates(opts: {
  orgRoot: string;
  url: URL;
  token?: string;
  username?: string;
  branch: string;
  skillBases: Record<string, string>;
  uploadedPacks: Map<string, Map<string, string>>;
  reservedPackIds?: string[];
}): Promise<RemoteUpdates> {
  const root = resolve(opts.orgRoot);
  return withRepoLock(root, async () => {
    const tip = await fetchRemote(root, opts.url, opts.branch, opts.token, opts.username);
    if (!tip) return { tip: null, skills: [], packs: [] };
    const head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();
    const local = head ? await folderTrees(root, head, "skills") : new Map<string, string>();
    const remote = await folderTrees(root, tip, "skills");

    const skills: SkillUpdate[] = [];
    for (const [name, remoteTree] of [...remote].sort(([a], [b]) => a.localeCompare(b))) {
      const localTree = local.get(name);
      const base = opts.skillBases[name];
      if (localTree === remoteTree) continue;
      if (base && remoteTree === base) continue;
      skills.push({ name, remoteTree, status: localTree === undefined || (base && localTree === base) ? "update" : "both_changed" });
    }

    const { hashPackFiles, stagePackArchive } = await import("@neko/packs");
    const packs: PackUpdate[] = [];
    const scratch = await mkdtemp(join(tmpdir(), "neko-remote-pack-"));
    try {
      for (const id of [...(await folderTrees(root, tip, "packs")).keys()].sort()) {
        try {
          const staged = await stagePackArchive(await remotePackArchive(root, tip, id), scratch, { reservedIds: opts.reservedPackIds ?? [] });
          try {
            const version = staged.bundle.manifest.metadata.version;
            const contentHash = await hashPackFiles(staged.bundle.root);
            const versions = opts.uploadedPacks.get(id);
            const existing = versions?.get(version);
            if (existing === contentHash) continue;
            packs.push(existing
              ? { id, version, status: "invalid", detail: `Version ${version} changed in the repository. Raise the version number in pack.yaml.` }
              : { id, version, status: versions ? "new_version" : "new_pack", detail: versions ? `Version ${version} is available.` : `New pack, version ${version}.` });
          } finally {
            await staged.cleanup();
          }
        } catch (error) {
          packs.push({ id, version: null, status: "invalid", detail: (error as Error).message });
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    return { tip, skills, packs };
  });
}

/**
 * Replace each named skill with the remote tip's copy and commit it as one
 * version. Returns the new HEAD, or null when nothing changed.
 */
export async function bringInRemoteSkills(opts: { orgRoot: string; tip: string; names: string[]; message: string }): Promise<string | null> {
  const root = resolve(opts.orgRoot);
  if (opts.names.length === 0) return null;
  return withRepoLock(root, async () => {
    const paths = opts.names.map((name) => `skills/${name}`);
    await git(root, ["rm", "-r", "-q", "--ignore-unmatch", "--", ...paths]);
    await git(root, ["checkout", opts.tip, "--", ...paths]);
    const { stdout: status } = await git(root, ["status", "--porcelain", "--", ...paths]);
    if (!status.trim()) return null;
    await git(root, ["commit", "-q", "-m", opts.message, "--", ...paths]);
    return (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  });
}

/** Tree id of each published skill in a commit, for the sync record after a push. */
export async function skillTreesAt(orgRoot: string, ref: string): Promise<Record<string, string>> {
  return Object.fromEntries(await folderTrees(resolve(orgRoot), ref, "skills"));
}
