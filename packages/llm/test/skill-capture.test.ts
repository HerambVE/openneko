import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureSandboxSkillEdits,
  diffSkillTrees,
  hashSkillTree,
  readPersonalSkillFiles,
  SANDBOX_SKILL_HASH_COMMAND,
} from "../src/config-vcs/skill-capture";
import { userConfigRef } from "../src/config-vcs/forks";
import { commitConfigChange } from "../src/config-vcs/index";

let root: string;
let orgRoot: string;
let box: string;
let boxHashes = new Map<string, string>();

const git = (...args: string[]) => execFileSync("git", args, { cwd: orgRoot, encoding: "utf8" });

async function put(base: string, path: string, content: string) {
  await mkdir(join(base, path, ".."), { recursive: true });
  await writeFile(join(base, path), content);
}

function capture(actor: { userId: string | null; role: string | null }, baseline: Map<string, string>) {
  return captureSandboxSkillEdits({
    listSandboxHashes: async () => `noise\n${JSON.stringify(Object.fromEntries(boxHashes))}`,
    downloadSkill: async (skill, destination) => cp(join(box, skill), destination, { recursive: true }),
    orgRoot,
    orgId: "org-1",
    runId: "run-12345678-aaaa",
    actor,
    baseline,
  });
}


beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skill-capture-"));
  orgRoot = join(root, "org-1");
  box = join(root, "box");
  await put(join(orgRoot, "skills"), "shortfall/SKILL.md", "# Shortfall\n");
  await put(join(orgRoot, "skills"), "shortfall/scripts/calculate.py", "print(1)\n");
  await put(join(orgRoot, "skills"), "other/SKILL.md", "# Other\n");
  await commitConfigChange({ workspaceRoot: orgRoot, paths: ["skills"], message: "Seed skills" });
  await cp(join(orgRoot, "skills"), box, { recursive: true });
  await rm(join(box, "other"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("SANDBOX_SKILL_HASH_COMMAND", () => {
  it("lists the same hashes as the host", async () => {
    await put(box, "shortfall/__pycache__/calculate.cpython-311.pyc", "x");
    await put(box, "shortfall/._SKILL.md", "x");
    const listed = execFileSync("python3", ["-c", SANDBOX_SKILL_HASH_COMMAND, box], { encoding: "utf8" });
    expect(new Map(Object.entries(JSON.parse(listed)))).toEqual(await hashSkillTree(box));
  });
});

describe("diffSkillTrees", () => {
  it("finds changed, added and removed files, and ignores skills the run never received", () => {
    const baseline = new Map([["a/SKILL.md", "1"], ["a/old.py", "2"], ["b/SKILL.md", "3"]]);
    const sandbox = new Map([["a/SKILL.md", "9"], ["a/new.py", "4"], ["a/__pycache__/x.pyc", "5"]]);
    expect(diffSkillTrees(baseline, sandbox)).toEqual({ changed: ["a/SKILL.md", "a/new.py"], removed: ["a/old.py"] });
  });
});

describe("captureSandboxSkillEdits", () => {
  it("saves an admin's sandbox edits to the company skills as one version", async () => {
    const baseline = await hashSkillTree(join(orgRoot, "skills"));
    await put(box, "shortfall/scripts/calculate.py", "print(2)\n");
    await put(box, "shortfall/references/new.md", "notes\n");
    boxHashes = await hashSkillTree(box);

    const saved = await capture({ userId: "u-admin", role: "admin" }, baseline);

    expect(saved).toMatchObject({ scope: "team", skills: ["shortfall"], skipped: [] });
    expect(saved?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(orgRoot, "skills/shortfall/scripts/calculate.py"), "utf8")).toBe("print(2)\n");
    expect(await readFile(join(orgRoot, "skills/other/SKILL.md"), "utf8")).toBe("# Other\n");
    expect(git("log", "-1", "--pretty=%s").trim()).toBe("Updated skill in run run-1234: shortfall");
    expect(git("show", "--name-only", "--pretty=", "HEAD").trim().split("\n").sort()).toEqual([
      "skills/shortfall/references/new.md",
      "skills/shortfall/scripts/calculate.py",
    ]);
  });

  it("keeps a host change made by another writer during the turn", async () => {
    const baseline = await hashSkillTree(join(orgRoot, "skills"));
    await put(join(orgRoot, "skills"), "shortfall/SKILL.md", "# Edited elsewhere\n");
    await put(box, "shortfall/SKILL.md", "# Edited in the box\n");
    boxHashes = await hashSkillTree(box);

    const saved = await capture({ userId: null, role: null }, baseline);

    expect(saved?.skipped).toEqual(["shortfall/SKILL.md"]);
    expect(await readFile(join(orgRoot, "skills/shortfall/SKILL.md"), "utf8")).toBe("# Edited elsewhere\n");
  });

  it("saves a member's edits to their personal version only", async () => {
    const baseline = await hashSkillTree(join(orgRoot, "skills"));
    await put(box, "shortfall/SKILL.md", "# Mine\n");
    boxHashes = await hashSkillTree(box);

    const saved = await capture({ userId: "u-member", role: "member" }, baseline);

    expect(saved).toMatchObject({ scope: "user", skills: ["shortfall"] });
    expect(await readFile(join(orgRoot, "skills/shortfall/SKILL.md"), "utf8")).toBe("# Shortfall\n");
    expect(git("show", `${userConfigRef("u-member")}:skills/shortfall/SKILL.md`)).toBe("# Mine\n");
    expect(await readPersonalSkillFiles(orgRoot, "u-member")).toEqual([
      { path: "shortfall/SKILL.md", content: Buffer.from("# Mine\n") },
    ]);
  });

  it("does nothing when the sandbox skills match what the run received", async () => {
    const baseline = await hashSkillTree(join(orgRoot, "skills"));
    boxHashes = await hashSkillTree(box);
    expect(await capture({ userId: "u-admin", role: "admin" }, baseline)).toBeNull();
  });
});
