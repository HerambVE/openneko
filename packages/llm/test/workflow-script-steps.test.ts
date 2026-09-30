import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, AgentWorkspace } from "../src/agent-backend";
import {
  expandArg,
  formatScriptStepResults,
  runScriptSteps,
} from "../src/workflows/script-steps";

let root: string;
let workspace: AgentWorkspace;
const events: AgentEvent[] = [];
const emit = async (event: AgentEvent) => {
  events.push(event);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "neko-steps-"));
  workspace = {
    orgRoot: root,
    skillsRoot: join(root, "skills"),
    memoryRoot: join(root, "memory"),
    knowledgeRoot: join(root, "knowledge"),
    uploadsRoot: join(root, "uploads"),
    runsRoot: join(root, "runs"),
    threadUploadsRoot: join(root, "uploads", "t"),
    runRoot: join(root, "runs", "r"),
    artifactRoot: join(root, "runs", "r", "artifacts"),
    binRoot: join(root, "runs", "r", "bin"),
  };
  await mkdir(join(workspace.skillsRoot, "lead-union", "scripts"), { recursive: true });
  await mkdir(workspace.runRoot, { recursive: true });
  await writeFile(
    join(workspace.skillsRoot, "lead-union", "scripts", "run.py"),
    [
      "import json, os, sys",
      "day = sys.argv[1]",
      "if day == 'fail':",
      "    print('bad day', file=sys.stderr)",
      "    sys.exit(3)",
      "if day == 'sleep':",
      "    import time; time.sleep(30)",
      "open(os.path.join(os.environ['RUN_DIR'], 'out.csv'), 'w').write('day\\n' + day)",
      "print(json.dumps({'day': day, 'input': json.loads(os.environ['OPENNEKO_WORKFLOW_INPUT'])}))",
    ].join("\n"),
  );
  events.length = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const step = (id: string, day: string, timeoutSeconds?: number) => ({
  id,
  description: `run ${id}`,
  script: {
    skill: "lead-union",
    command: ["python3", "${SKILL_DIR}/scripts/run.py", day],
    ...(timeoutSeconds ? { timeoutSeconds } : {}),
  },
});

describe("expandArg", () => {
  it("expands run variables and trigger input with defaults", () => {
    const vars = { RUN_DIR: "/run" };
    expect(expandArg("${RUN_DIR}/out.csv", vars, {})).toBe("/run/out.csv");
    expect(expandArg("${input.date}", vars, { date: "2026-09-29" })).toBe("2026-09-29");
    expect(expandArg("${input.date:-}", vars, {})).toBe("");
    expect(expandArg("--n=${input.n:-5}", vars, {})).toBe("--n=5");
    expect(() => expandArg("${input.date}", vars, {})).toThrow(/no date/);
    expect(() => expandArg("${HOME}", vars, {})).toThrow(/unknown variable/);
  });
});

describe("runScriptSteps", () => {
  it("runs a skill script from the run directory with the trigger input", async () => {
    const results = await runScriptSteps({
      steps: [
        { id: "plan", description: "agent step" },
        { ...step("union", "${input.date}") },
      ],
      workspace,
      input: { date: "2026-09-29" },
      emit,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "union", status: "ok", exitCode: 0 });
    expect(JSON.parse(results[0]!.stdoutTail!)).toEqual({
      day: "2026-09-29",
      input: { date: "2026-09-29" },
    });
    expect(await readFile(join(workspace.runRoot, "out.csv"), "utf8")).toBe("day\n2026-09-29");
    expect(await readFile(results[0]!.stdoutPath!, "utf8")).toContain("2026-09-29");
    expect(events.map((e) => e.type)).toEqual(["status", "status"]);
  });

  it("skips the remaining steps after a failure", async () => {
    const results = await runScriptSteps({
      steps: [step("first", "fail"), step("second", "ok")],
      workspace,
      emit,
    });

    expect(results.map((r) => r.status)).toEqual(["failed", "skipped"]);
    expect(results[0]).toMatchObject({ exitCode: 3, stderrTail: "bad day" });
    expect(results[1]!.error).toContain("step first");
  });

  it("kills a step that exceeds its timeout", async () => {
    const results = await runScriptSteps({
      steps: [step("slow", "sleep", 1)],
      workspace,
      emit,
    });
    expect(results[0]).toMatchObject({ status: "timeout" });
    expect(results[0]!.error).toContain("timed out after 1s");
  });

  it("refuses a skill the run does not hold", async () => {
    const results = await runScriptSteps({
      steps: [step("union", "ok")],
      workspace,
      allowedSkills: ["other-skill"],
      emit,
    });
    expect(results[0]).toMatchObject({ status: "failed" });
    expect(results[0]!.error).toContain("not available");
  });

  it("formats results for the agent turn", async () => {
    const results = await runScriptSteps({
      steps: [step("first", "fail")],
      workspace,
      emit,
    });
    const block = formatScriptStepResults(results);
    expect(block).toContain('<step id="first" status="failed" exit_code="3"');
    expect(block).toContain("stderr_tail:\nbad day");
    expect(formatScriptStepResults([])).toBe("");
  });
});
