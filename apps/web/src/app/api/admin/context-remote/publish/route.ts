import { NextResponse } from "next/server";
import { ContextRemoteError, getContextRemote, publishOrgContext } from "@neko/llm/config-vcs";
import { getOrgAgentRoot } from "@neko/llm/work";
import { isDenied, requireAdminActor } from "@/lib/admin-auth";
import { getOrgId } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const actor = await requireAdminActor();
  if (isDenied(actor)) return actor;
  const orgId = await getOrgId();
  try {
    const result = await publishOrgContext(orgId, getOrgAgentRoot(orgId), actor.userId);
    return NextResponse.json({ result, remote: await getContextRemote(orgId) });
  } catch (error) {
    if (error instanceof ContextRemoteError) {
      return NextResponse.json({ error: error.message, remote: await getContextRemote(orgId) }, { status: 400 });
    }
    throw error;
  }
}
