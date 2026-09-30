import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { AgentEvent, AgentWorkspace } from "../agent-backend";
import type { WorkflowStep } from "./store";

export type ScriptStepResult = {
  id: string;
  description: string;
  status: "ok" | "failed" | "timeout" | "skipped";
  exitCode: number | null;
  durationMs: number;
  stdoutPath?: string;
  stderrPath?: string;
  stdoutTail?: string;
  stderrTail?: string;
  error?: string;
};

const DEFAULT_TIMEOUT_SECONDS = 1_200;
const TAIL_BYTES = 4_000;

/**
 * Runs a workflow's script steps in order before the agent turn. The first
 * failure skips the remaining steps; the agent receives every result.
 */
export async function runScriptSteps(opts: {
  steps: readonly WorkflowStep[];
  workspace: AgentWorkspace;
  input?: Record<string, unknown>;
  allowedSkills?: readonly string[];
  emit: (event: AgentEvent) => Promise<void>;
  signal?: AbortSignal;
}): Promise<ScriptStepResult[]> {
  const results: ScriptStepResult[] = [];
  let blocked: string | null = null;
  for (const step of opts.steps) {
    if (!step.script) continue;
    if (blocked) {
      results.push({
        id: step.id,
        description: step.description,
        status: "skipped",
        exitCode: null,
        durationMs: 0,
        error: `skipped because step ${blocked} did not succeed`,
      });
      continue;
    }
    await opts.emit({ type: "status", message: `Running script step: ${step.description}` });
    const result = await runOne(step, opts);
    results.push(result);
    await opts.emit({
      type: "status",
      message: `Script step ${step.id} ${result.status} in ${Math.round(result.durationMs / 1000)}s`,
    });
    if (result.status !== "ok") blocked = step.id;
  }
  return results;
}

async function runOne(
  step: WorkflowStep,
  opts: Parameters<typeof runScriptSteps>[0],
): Promise<ScriptStepResult> {
  const script = step.script!;
  const base = { id: step.id, description: step.description };
  const started = Date.now();
  const fail = (error: string): ScriptStepResult => ({
    ...base,
    status: "failed",
    exitCode: null,
    durationMs: Date.now() - started,
    error,
  });

  if (opts.allowedSkills && !opts.allowedSkills.includes(script.skill)) {
    return fail(`skill ${script.skill} is not available to this run`);
  }
  const skillsRoot = resolve(opts.workspace.skillsRoot);
  const skillDir = resolve(skillsRoot, script.skill);
  if (relative(skillsRoot, skillDir).startsWith("..") || !existsSync(skillDir)) {
    return fail(`skill ${script.skill} is not installed`);
  }

  const vars: Record<string, string> = {
    SKILL_DIR: skillDir,
    RUN_DIR: opts.workspace.runRoot,
    ARTIFACT_DIR: opts.workspace.artifactRoot,
  };
  let argv: string[];
  try {
    argv = script.command.map((arg) => expandArg(arg, vars, opts.input ?? {}));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const logDir = join(opts.workspace.runRoot, "steps");
  await mkdir(logDir, { recursive: true });
  const stdoutPath = join(logDir, `${safeName(step.id)}.stdout.log`);
  const stderrPath = join(logDir, `${safeName(step.id)}.stderr.log`);
  const stdout = new Tail(stdoutPath);
  const stderr = new Tail(stderrPath);
  const timeoutMs = (script.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1_000;

  const outcome = await new Promise<{ code: number | null; timedOut: boolean; error?: string }>(
    (done) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: opts.workspace.runRoot,
        env: {
          ...process.env,
          ...vars,
          OPENNEKO_WORKFLOW_INPUT: JSON.stringify(opts.input ?? {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let timedOut = false;
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      const onAbort = () => kill();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => stdout.write(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.write(chunk));
      child.on("error", (err) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        done({ code: null, timedOut, error: err.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        done({ code, timedOut });
      });
    },
  );
  await Promise.all([stdout.close(), stderr.close()]);

  return {
    ...base,
    status: outcome.timedOut ? "timeout" : outcome.code === 0 ? "ok" : "failed",
    exitCode: outcome.code,
    durationMs: Date.now() - started,
    stdoutPath,
    stderrPath,
    stdoutTail: stdout.tail(),
    stderrTail: stderr.tail(),
    ...(outcome.error
      ? { error: outcome.error }
      : outcome.timedOut
        ? { error: `timed out after ${timeoutMs / 1000}s` }
        : {}),
  };
}

const ARG_VAR = /\$\{(input\.[A-Za-z0-9_]+|[A-Z_]+)(?::-([^}]*))?\}/g;

export function expandArg(
  arg: string,
  vars: Record<string, string>,
  input: Record<string, unknown>,
): string {
  return arg.replace(ARG_VAR, (_match, name: string, fallback: string | undefined) => {
    if (name.startsWith("input.")) {
      const value = input[name.slice("input.".length)];
      if (value === undefined || value === null || value === "") {
        if (fallback !== undefined) return fallback;
        throw new Error(`the trigger payload has no ${name.slice(6)} for \${${name}}`);
      }
      return typeof value === "string" ? value : JSON.stringify(value);
    }
    const value = vars[name];
    if (value === undefined) throw new Error(`unknown variable \${${name}}`);
    return value;
  });
}

/** The `<step_results>` block the agent turn receives. */
export function formatScriptStepResults(results: readonly ScriptStepResult[]): string {
  if (results.length === 0) return "";
  const body = results
    .map((r) => {
      const lines = [
        `<step id="${r.id}" status="${r.status}" exit_code="${r.exitCode ?? ""}" duration_s="${Math.round(r.durationMs / 1000)}">`,
        `description: ${r.description}`,
      ];
      if (r.error) lines.push(`error: ${r.error}`);
      if (r.stdoutPath) lines.push(`stdout_file: ${r.stdoutPath}`);
      if (r.stderrPath) lines.push(`stderr_file: ${r.stderrPath}`);
      if (r.stdoutTail) lines.push(`stdout_tail:\n${r.stdoutTail}`);
      if (r.status !== "ok" && r.stderrTail) lines.push(`stderr_tail:\n${r.stderrTail}`);
      lines.push("</step>");
      return lines.join("\n");
    })
    .join("\n");
  return `<step_results>
The workflow's script steps already ran in the run directory before this turn.
Use their output files. Rerun a step's command only to fix a failure you
understand.

${body}
</step_results>`;
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "step";
}

class Tail {
  private readonly file;
  private buffer = Buffer.alloc(0);

  constructor(path: string) {
    this.file = createWriteStream(path);
  }

  write(chunk: Buffer): void {
    this.file.write(chunk);
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > TAIL_BYTES * 2) {
      this.buffer = this.buffer.subarray(this.buffer.length - TAIL_BYTES);
    }
  }

  tail(): string {
    return this.buffer.subarray(Math.max(0, this.buffer.length - TAIL_BYTES)).toString("utf8").trim();
  }

  close(): Promise<void> {
    return new Promise((done) => this.file.end(() => done()));
  }
}
