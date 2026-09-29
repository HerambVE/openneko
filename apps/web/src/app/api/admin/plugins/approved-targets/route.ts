import { NextResponse } from "next/server";
import { getActionPolicyByName, upsertActionPolicyByName } from "@neko/llm/workflows";
import { isDenied, requireAdminActor } from "@/lib/admin-auth";
import { getOrgId } from "@/lib/db";
import { requestPluginWorker, type PluginSettings } from "@/lib/plugin-admin";
import { approvedTargetsRuleName, parseTargetPatterns } from "@/lib/target-patterns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function targetActions() {
  const result = await requestPluginWorker("/admin/plugins/settings");
  if (result.status !== 200) throw new Error("could not read plugin settings from the worker");
  return ((result.body as { plugins?: PluginSettings[] }).plugins ?? []).flatMap((p) =>
    p.targetActions.map((a) => ({ ...a, pluginName: p.name })),
  );
}

/** The approved-target list of every plugin action that declares targets. */
export async function GET() {
  const allowed = await requireAdminActor();
  if (isDenied(allowed)) return allowed;
  try {
    const orgId = await getOrgId();
    const actions = await targetActions();
    const lists = await Promise.all(
      actions.map(async (action) => {
        const rule = await getActionPolicyByName(orgId, approvedTargetsRuleName(action.kind));
        const patterns = Array.isArray(rule?.allowedTargets?.patterns) ? (rule.allowedTargets.patterns as string[]) : [];
        return { kind: action.kind, pluginName: action.pluginName, as: action.as, patterns: rule?.enabled ? patterns : [], ruleId: rule?.id ?? null };
      }),
    );
    return NextResponse.json({ lists });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

/**
 * Saves the list as one rule per action: send without approval when every
 * target is on the list; any other target goes to the next rule, which asks.
 */
export async function POST(request: Request) {
  const allowed = await requireAdminActor();
  if (isDenied(allowed)) return allowed;
  const body = (await request.json().catch(() => null)) as { kind?: unknown; patterns?: unknown } | null;
  const kind = typeof body?.kind === "string" ? body.kind : "";
  let action;
  try {
    action = (await targetActions()).find((a) => a.kind === kind);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
  if (!action) return NextResponse.json({ error: `no installed plugin action ${kind} declares targets` }, { status: 400 });
  const parsed = parseTargetPatterns(body?.patterns, action.as);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const orgId = await getOrgId();
  const { policy } = await upsertActionPolicyByName({
    orgId,
    name: approvedTargetsRuleName(kind),
    description: `Run ${kind} without approval when every target is on this list. Any other target goes to the next rule.`,
    appliesToKinds: [kind],
    appliesToScopes: ["external"],
    mode: "auto_approve",
    riskThresholdAutoApprove: null,
    allowedTargets: { patterns: parsed.patterns, on_miss: "next" },
    deniedTargets: null,
    limits: {},
    priority: 100,
    enabled: parsed.patterns.length > 0,
  });
  return NextResponse.json({ kind, patterns: parsed.patterns, ruleId: policy.id });
}
