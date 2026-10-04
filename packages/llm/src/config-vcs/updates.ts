import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hashPackFiles, stagePackArchive } from "@neko/packs";
import { git } from "./git-shell";
import { withRepoLock } from "./lock";
import { readRow, remoteAccess } from "./remote-settings";
import {
  ContextRemoteError,
  fetchRemote,
  folderTrees,
  parseRemoteUrl,
  remotePackArchive,
  remoteTransport,
  type PackUpdate,
  type RemoteAccess,
  type RemoteUpdates,
  type SkillUpdate,
} from "./remote";

/**
 * Checking a repository for pack updates validates packs with @neko/packs.
 * That package is not part of the web bundle, so only the worker loads this
 * module. The web app reads the result through the worker's admin API.
 */

/**
 * Compare the remote branch with OpenNeko's skills and packs.
 * `skillBases` holds each skill's tree at its last sync with this remote.
 * `uploadedPacks` maps a pack id to its uploaded versions and their content hashes.
 */
export async function checkRemoteUpdates(opts: {
  orgRoot: string;
  access: RemoteAccess;
  branch: string;
  skillBases: Record<string, string>;
  uploadedPacks: Map<string, Map<string, string>>;
  reservedPackIds?: string[];
}): Promise<RemoteUpdates> {
  const root = resolve(opts.orgRoot);
  return withRepoLock(root, async () => {
    const tip = await fetchRemote(root, opts.access, opts.branch);
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


async function uploadedPackVersions(orgRoot: string): Promise<Map<string, Map<string, string>>> {
  const packs = new Map<string, Map<string, string>>();
  for (const id of await readdir(join(orgRoot, "packs")).catch(() => [] as string[])) {
    const versions = new Map<string, string>();
    for (const version of await readdir(join(orgRoot, "packs", id, "versions")).catch(() => [] as string[])) {
      const upload = await readFile(join(orgRoot, "packs", id, "versions", version, "upload.json"), "utf8")
        .then((text) => JSON.parse(text) as { contentHash?: string })
        .catch(() => null);
      if (upload?.contentHash) versions.set(version, upload.contentHash);
    }
    if (versions.size) packs.set(id, versions);
  }
  return packs;
}

/** Skills and packs that changed in the remote repository. */
export async function checkOrgUpdates(orgId: string, orgRoot: string): Promise<RemoteUpdates> {
  const row = await readRow(orgId);
  if (!row) throw new ContextRemoteError("Connect a remote repository first.");
  return checkRemoteUpdates({
    orgRoot,
    access: remoteAccess(row),
    branch: row.branch,
    skillBases: row.skill_bases ?? {},
    uploadedPacks: await uploadedPackVersions(orgRoot),
  });
}

