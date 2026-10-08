import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { NextRequest } from "next/server";
import {
  createTestOrg,
  dbReachable,
  deleteTestOrg,
  uniqueOrgId,
} from "@neko/db/test-helpers";
import {
  db,
  eq,
  pool,
  work_run,
  work_run_event,
  work_thread,
} from "@neko/db";

const { mockGetOrgId } = vi.hoisted(() => ({
  mockGetOrgId: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return { ...actual, getOrgId: mockGetOrgId };
});

const reachable = await dbReachable();
const describeIfDb = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn("[api/work/events] skipping: Postgres unreachable.");
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value));
  }
  return chunks;
}

describeIfDb("/api/work/threads/[threadId]/runs/[runId]/events GET", () => {
  let orgId: string;
  let threadId: string;
  let runId: string;
  let GET: typeof import("@/app/api/work/threads/[threadId]/runs/[runId]/events/route").GET;

  beforeAll(async () => {
    const mod = await import("@/app/api/work/threads/[threadId]/runs/[runId]/events/route");
    GET = mod.GET;
  });

  beforeEach(async () => {
    orgId = uniqueOrgId("api-work-events");
    await createTestOrg(orgId);
    mockGetOrgId.mockResolvedValue(orgId);

    const [threadIns] = await db()
      .insert(work_thread)
      .values({ org_id: orgId, title: "" })
      .returning();
    threadId = threadIns!.id;

    const [runIns] = await db()
      .insert(work_run)
      .values({
        org_id: orgId,
        thread_id: threadId,
        backend: "hermes",
        status: "running",
      })
      .returning();
    runId = runIns!.id;
  });

  afterEach(async () => {
    await deleteTestOrg(orgId);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await pool().end();
  });

  it("waits for real done event even if db run status is terminal early", async () => {
    const req = new NextRequest(`http://localhost:3000/api/work/threads/${threadId}/runs/${runId}/events`);
    const resPromise = GET(req, { params: Promise.resolve({ threadId, runId }) });

    // The route responds immediately with a Response object holding a stream
    const res = await resPromise;
    expect(res.status).toBe(200);
    const stream = res.body as ReadableStream<Uint8Array>;
    expect(stream).toBeTruthy();

    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // Read the "hello" comment and "hello" event
    const { value: v1 } = await reader.read();
    const helloData = decoder.decode(v1);
    expect(helloData).toContain("hello");

    // 1. Mark run as terminal (completed) in DB. This simulates finishWorkRun().
    await db().update(work_run).set({ status: "completed" }).where(eq(work_run.id, runId));

    // Wait a short time (less than the 5_000ms timeout)
    await new Promise(r => setTimeout(r, 1000));

    // 2. The stream should still be open (the reader is pending).
    // Let's insert the "done" event into the DB.
    await db().insert(work_run_event).values({
      org_id: orgId,
      thread_id: threadId,
      run_id: runId,
      kind: "done",
      payload: { type: "done", result: { status: "completed", minutesSaved: 1 } },
    });

    // To wake up the SSE loop (which relies on pg_notify), we notify
    await pool().query(`NOTIFY work_run_event, '${runId}'`);

    // The reader should now yield the "done" event
    const { done, value: v2 } = await reader.read();
    expect(done).toBe(false);
    const eventData = decoder.decode(v2);
    expect(eventData).toContain("done");

    // Next read should yield done: true as the route exits the loop when hasSentDone is true
    const { done: finalDone } = await reader.read();
    expect(finalDone).toBe(true);
  });
});
