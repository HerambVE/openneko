import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "./git-shell";
import { withRepoLock } from "./lock";
import { withSshEnv } from "./ssh";

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

/**
 * An HTTPS or SSH git address with no secret, query or fragment. The short SSH
 * form `git@host:org/repo.git` becomes `ssh://git@host/org/repo.git`.
 * Tests may use a file URL.
 */
export function parseRemoteUrl(value: string, options: { allowFile?: boolean } = {}): URL {
  const text = value.trim();
  const short = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(?!\/)([^\s]+)$/.exec(text);
  let url: URL;
  try {
    url = new URL(short ? `ssh://${short[1]}@${short[2]}/${short[3]}` : text);
  } catch {
    throw new ContextRemoteError("Enter the repository's address, such as https://github.com/acme/openneko-context.git or git@github.com:acme/openneko-context.git.");
  }
  if (url.protocol === "file:" && options.allowFile) return url;
  if (url.protocol !== "https:" && url.protocol !== "ssh:") {
    throw new ContextRemoteError("The repository address must start with https:// or ssh://, or have the form git@host:org/repo.git.");
  }
  if (url.password || (url.protocol === "https:" && url.username)) {
    throw new ContextRemoteError("Put the access token in the token field, not in the address.");
  }
  if (url.search || url.hash || url.pathname.split("/").filter(Boolean).length < 2) {
    throw new ContextRemoteError("The address must name a repository, such as https://github.com/acme/openneko-context.git.");
  }
  return url;
}

export function remoteTransport(url: URL): "https" | "ssh" | "file" {
  return url.protocol === "ssh:" ? "ssh" : url.protocol === "file:" ? "file" : "https";
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

/**
 * How OpenNeko reaches a remote. Over HTTPS the token authenticates git. Over
 * SSH the deploy key authenticates git, and the token only opens pull requests.
 */
export type RemoteAccess = {
  url: URL;
  token?: string;
  username?: string;
  ssh?: { privateKey: string; knownHosts: string };
};

/** Run fn with an environment that authenticates git. No credential appears in an argument or error. */
async function withGitAuth<T>(access: RemoteAccess, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" };
  if (remoteTransport(access.url) === "ssh") {
    if (!access.ssh) throw new ContextRemoteError("This SSH remote has no deploy key.");
    return withSshEnv(access.ssh, (sshEnv) => fn({ ...env, ...sshEnv }));
  }
  if (!access.token) return fn(env);
  const user = access.username || (remoteProvider(access.url) === "gitlab" ? "oauth2" : "x-access-token");
  return fn({
    ...env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${user}:${access.token}`).toString("base64")}`,
  });
}

function scrub(message: string, access: RemoteAccess): string {
  let out = message;
  if (access.token) out = out.split(access.token).join("***").split(Buffer.from(access.token).toString("base64")).join("***");
  return out;
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
    : await opts.fetchImpl(`https://${remoteTransport(opts.url) === "ssh" ? opts.url.hostname : opts.url.host}/api/v4/projects/${encodeURIComponent(path)}/merge_requests`, {
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
  access: RemoteAccess;
  mode: ContextRemoteMode;
  branch: string;
  kinds: readonly ContextRemoteKind[];
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<PublishResult> {
  const root = resolve(opts.orgRoot);
  const { access } = opts;
  const remote = access.url.toString();

  return withRepoLock(root, () => withGitAuth(access, async (env) => {
    const run = (args: string[]) => git(root, args, { env }).catch((error: Error) => {
      throw new ContextRemoteError(scrub(error.message, access));
    });
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
        link: remoteProvider(access.url) === "github" ? `https://github.com/${repositoryPath(access.url)}/tree/${opts.branch}` : null,
        detail: base ? `Pushed to ${opts.branch}.` : `Created ${opts.branch} on the remote.`,
      };
    }

    const stamp = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const head_branch = `openneko/context-${stamp}`;
    await run(["push", "--quiet", remote, `${sha}:refs/heads/${head_branch}`]);
    const link = await openPullRequest({
      url: access.url,
      token: access.token,
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
  }));
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
export async function folderTrees(root: string, ref: string, prefix: string): Promise<Map<string, string>> {
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
export async function fetchRemote(root: string, access: RemoteAccess, branch: string): Promise<string | null> {
  const tracking = `refs/openneko/remote/${branch}`;
  try {
    await withGitAuth(access, (env) => git(root, ["fetch", "--no-tags", "--quiet", access.url.toString(), `+refs/heads/${branch}:${tracking}`], { env }));
  } catch (error) {
    if (/couldn't find remote ref/i.test((error as Error).message)) return null;
    throw error instanceof ContextRemoteError ? error : new ContextRemoteError(scrub((error as Error).message, access));
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
