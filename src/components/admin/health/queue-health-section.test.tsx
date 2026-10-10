/**
 * The admin "Job runner" section (scaling ladder M-3), server-rendered with a pre-filled query cache (the way the hooks
 * read it on first paint). There is no browser here, so this is what proves the section renders each tick state and
 * the lists, and that error text is escaped.
 */
import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { QueueHealthSection } from "./queue-health-section";

const PATH = "admin.queue.getHealth";

function render(data: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (data !== undefined) client.setQueryData(["rpc", PATH, {}], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <QueueHealthSection />
    </QueryClientProvider>,
  );
}

const counts = (c: Record<string, number> = {}) => ({ pending: 0, scheduled: 0, processing: 0, failedLast24h: 0, ...c });
/** admin.queue.getHealth in the wire format: null fields are absent, instants are epoch ms, `id` is `_id`. */
const health = (over: Record<string, unknown> = {}) => ({
  queue: { jobs: counts(), tasks: counts() },
  failedTasks: [],
  scheduleErrors: [],
  tick: { stale: false, lastRunAt: Date.now() - 30_000, ageMs: 30_000 },
  ...over,
});

describe("QueueHealthSection", () => {
  test("renders while loading, without any tick claim", () => {
    const html = render(undefined);
    expect(html).toContain("Job runner");
    expect(html).not.toContain("Tick");
  });

  test("a fresh heartbeat says the tick is running, with its age", () => {
    const html = render(health());
    expect(html).toContain("Tick running.");
    expect(html).toContain("30 seconds");
    expect(html).not.toContain("Tick stale");
  });

  test("a stale heartbeat is an alert that says so, with how long ago", () => {
    const html = render(health({ tick: { stale: true, lastRunAt: Date.now() - 7 * 60_000, ageMs: 7 * 60_000 } }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Tick stale.");
    expect(html).toContain("7 minutes");
    expect(html).not.toContain("Tick running");
  });

  test("no heartbeat ever recorded is neither running nor stale", () => {
    const html = render(health({ tick: { stale: false } }));
    expect(html).toContain("No tick recorded.");
    expect(html).not.toContain("Tick running");
    expect(html).not.toContain("Tick stale");
  });

  test("the last tick's own errors are shown next to a running tick", () => {
    expect(render(health({ tick: { stale: false, lastRunAt: Date.now(), ageMs: 1_000, lastError: "2 errors: sweep a: boom" } }))).toContain("2 errors: sweep a: boom");
  });

  test("counts, the oldest waiting age and scheduled work", () => {
    const html = render(
      health({ queue: { jobs: counts({ pending: 3, processing: 1, scheduled: 4, failedLast24h: 2 }), tasks: counts({ pending: 5, scheduled: 6, failedLast24h: 7 }), oldestPendingAgeMs: 4 * 60_000 } }),
    );
    for (const label of ["Jobs waiting", "Jobs running", "Tasks waiting", "Tasks running", "Oldest waiting", "Scheduled for later", "Failed jobs, 24 h", "Failed tasks, 24 h"]) expect(html).toContain(label);
    expect(html).toContain("4 minutes");
    expect(html).toContain(">10<"); // scheduled: 4 jobs + 6 tasks
    expect(html).toContain(">7<"); // failed tasks
  });

  test("nothing waiting says so, and an empty list says it is empty", () => {
    const html = render(health());
    expect(html).toContain(">None<");
    expect(html).toContain("No failed tasks.");
    expect(html).toContain("No sweep is failing.");
  });

  test("lists failed tasks and failing sweeps, and escapes their error text", () => {
    const html = render(
      health({
        failedTasks: [{ _id: "t1", kind: "analytics.ingest", attempts: 3, maxAttempts: 3, lastError: "<script>alert(1)</script> upstream 500", failedAt: Date.now() - 60_000 }],
        scheduleErrors: [{ name: "publish.sweep", lastRunAt: Date.now() - 120_000, lastError: "sweep exploded" }],
      }),
    );
    expect(html).toContain("analytics.ingest");
    expect(html).toContain("3/3");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; upstream 500");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("publish.sweep");
    expect(html).toContain("sweep exploded");
    expect(html).not.toContain("No failed tasks.");
    expect(html).not.toContain("No sweep is failing.");
  });
});
