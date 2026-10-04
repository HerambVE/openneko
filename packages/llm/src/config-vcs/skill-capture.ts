import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { git } from "./git-shell";
import { insertConfigChangeRow, recordConfigChange } from "./index";
import { commitToUserRef, userConfigRef } from "./forks";

/**
 * Skill edits made inside an agent sandbox are made to the sandbox's copy of
 * the skills tree. These helpers find what changed during a turn and save it
 * as a version: on main for admins and unattended runs, on the actor's
 * personal ref for everyone else.
 */

/** Relative path inside the skills root ("<skill>/<file>") to its sha256. */
export type SkillFileHashes = Map<string, string>;

export type SkillEditActor = { userId: string | null; role: string | null };

export type SavedSkillEdits = {
  scope: "team" | "user";
  sha: string | null;
  skills: string[];
  /** Files another writer changed on the host during the turn; left as they are. */
  skipped: string[];
};

function ignored(part: string): boolean {
  return part === "__pycache__" || part === ".DS_Store" || part.startsWith("._") || part.endsWith(".pyc");
}

function safeSkillPath(path: string): boolean {
  const parts = path.split("/");
  return parts.length >= 2 && parts.every((part) => part !== "" && part !== "." && part !== ".." && !ignored(part));
}

export function skillFileHash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function hashSkillTree(skillsRoot: string): Promise<SkillFileHashes> {
  const hashes: SkillFileHashes = new Map();
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (ignored(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), relative);
      else if (entry.isFile() && prefix) hashes.set(relative, skillFileHash(await readFile(join(directory, entry.name))));
    }
  };
  await walk(resolve(skillsRoot), "");
  return hashes;
}

/** Python run inside the sandbox: prints the same hash map as hashSkillTree. */
export const SANDBOX_SKILL_HASH_COMMAND = `
import hashlib, json, os, sys
root = sys.argv[1]
skip = lambda p: p == "__pycache__" or p == ".DS_Store" or p.startswith("._") or p.endswith(".pyc")
out = {}
if os.path.isdir(root):
    for directory, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if not skip(d)]
        rel = os.path.relpath(directory, root)
        if rel == ".":
            continue
        for name in files:
            if skip(name):
                continue
            with open(os.path.join(directory, name), "rb") as handle:
                out[(rel + "/" + name).replace(os.sep, "/")] = hashlib.sha256(handle.read()).hexdigest()
print(json.dumps(out))
`;

/**
 * Files the sandbox added or changed, and files it removed from a skill it
 * still holds. A skill the run never received is not treated as removed.
 */
export function diffSkillTrees(baseline: SkillFileHashes, box: SkillFileHashes): { changed: string[]; removed: string[] } {
  const changed = [...box].filter(([path, hash]) => safeSkillPath(path) && baseline.get(path) !== hash).map(([path]) => path);
  const boxSkills = new Set([...box.keys()].map((path) => path.split("/")[0]));
  const removed = [...baseline.keys()].filter((path) => !box.has(path) && boxSkills.has(path.split("/")[0]));
  return { changed: changed.sort(), removed: removed.sort() };
}

function teamScope(actor: SkillEditActor): boolean {
  return !actor.userId || actor.role === "admin";
}

export async function saveSkillEdits(opts: {
  orgRoot: string;
  orgId: string;
  runId: string;
  actor: SkillEditActor;
  baseline: SkillFileHashes;
  changed: Array<{ path: string; content: Buffer }>;
  removed: string[];
}): Promise<SavedSkillEdits> {
  const skillsRoot = join(resolve(opts.orgRoot), "skills");
  const skills = [...new Set([...opts.changed.map((file) => file.path), ...opts.removed].map((path) => path.split("/")[0]))].sort();
  const message = `Updated ${skills.length === 1 ? "skill" : "skills"} in run ${opts.runId.slice(0, 8)}: ${skills.join(", ")}`;

  if (!teamScope(opts.actor)) {
    const sha = await commitToUserRef({
      workspaceRoot: opts.orgRoot,
      userId: opts.actor.userId!,
      files: opts.changed.map((file) => ({ path: `skills/${file.path}`, content: file.content.toString("utf8") })),
      message,
      mode: "overlay",
    });
    if (sha) {
      await insertConfigChangeRow({
        orgId: opts.orgId,
        artifactKind: "skill",
        artifactRef: skills.join(", "),
        actorUserId: opts.actor.userId,
        commitSha: sha,
        summary: message,
        scope: "user",
        userId: opts.actor.userId!,
      });
    }
    return { scope: "user", sha, skills, skipped: [] };
  }

  const current = await hashSkillTree(skillsRoot);
  const skipped: string[] = [];
  const unchangedOnHost = (path: string) => current.get(path) === opts.baseline.get(path);
  for (const file of opts.changed) {
    if (!unchangedOnHost(file.path)) {
      skipped.push(file.path);
      continue;
    }
    const target = join(skillsRoot, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  for (const path of opts.removed) {
    if (!unchangedOnHost(path)) {
      skipped.push(path);
      continue;
    }
    await rm(join(skillsRoot, path), { force: true });
  }
  const sha = await recordConfigChange({
    workspaceRoot: opts.orgRoot,
    orgId: opts.orgId,
    paths: skills.map((skill) => `skills/${skill}`),
    message,
    artifactKind: "skill",
    artifactRef: skills.join(", "),
    actorUserId: opts.actor.userId,
  });
  return { scope: "team", sha, skills, skipped: skipped.sort() };
}

/**
 * Compare the sandbox's skills tree with the tree the run received, fetch the
 * skills that changed, and save them. Returns null when nothing changed.
 */
export async function captureSandboxSkillEdits(opts: {
  /** Runs SANDBOX_SKILL_HASH_COMMAND with the sandbox skills root and returns stdout. */
  listSandboxHashes: () => Promise<string>;
  /** Copies one sandbox skill directory into a local directory. */
  downloadSkill: (skill: string, destination: string) => Promise<void>;
  orgRoot: string;
  orgId: string;
  runId: string;
  actor: SkillEditActor;
  baseline: SkillFileHashes;
}): Promise<SavedSkillEdits | null> {
  const listed = JSON.parse((await opts.listSandboxHashes()).trim().split("\n").pop() || "{}") as Record<string, string>;
  const { changed, removed } = diffSkillTrees(opts.baseline, new Map(Object.entries(listed)));
  if (changed.length === 0 && removed.length === 0) return null;

  const scratch = await mkdtemp(join(tmpdir(), "neko-skill-capture-"));
  try {
    const files: Array<{ path: string; content: Buffer }> = [];
    for (const skill of [...new Set(changed.map((path) => path.split("/")[0]))]) {
      const destination = join(scratch, skill);
      await mkdir(destination, { recursive: true });
      await opts.downloadSkill(skill, destination);
      for (const path of changed.filter((candidate) => candidate.split("/")[0] === skill)) {
        const local = join(scratch, path);
        if (existsSync(local)) files.push({ path, content: await readFile(local) });
      }
    }
    return await saveSkillEdits({ ...opts, changed: files, removed });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The actor's personal skill files, laid over the company skills for their runs. */
export async function readPersonalSkillFiles(
  orgRoot: string,
  userId: string,
): Promise<Array<{ path: string; content: Buffer }>> {
  const root = resolve(orgRoot);
  if (!existsSync(join(root, ".git"))) return [];
  const ref = userConfigRef(userId);
  const listed = await git(root, ["ls-tree", "-r", "--name-only", ref, "--", "skills"]).catch(() => ({ stdout: "" }));
  const files: Array<{ path: string; content: Buffer }> = [];
  for (const path of listed.stdout.split("\n").filter(Boolean)) {
    const relative = path.slice("skills/".length);
    if (!safeSkillPath(relative)) continue;
    const { stdout } = await git(root, ["show", `${ref}:${path}`]);
    files.push({ path: relative, content: Buffer.from(stdout, "utf8") });
  }
  return files;
}
