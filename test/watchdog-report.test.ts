import { describe, expect, it } from "vitest";

import {
  assess,
  buildNotice,
  daysBetween,
  // Plain JS, so the workflow can run it with no install at all.
} from "../src/watchdog-report.mjs";

const NOW = new Date("2026-09-21T08:23:00Z");

/** A run as the Actions API returns it, trimmed to what is read. */
const run = (over: Record<string, unknown> = {}) => ({
  run_started_at: "2026-09-21T07:37:00Z",
  conclusion: "success",
  html_url: "https://github.com/o/r/actions/runs/1",
  ...over,
});

const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("daysBetween", () => {
  it("counts whole days and rounds towards the past", () => {
    expect(daysBetween(daysAgo(7), NOW)).toBe(7);
    // 7 days and 23 hours is still 7 - a run is not late until it is a day late.
    expect(daysBetween(new Date(NOW.getTime() - 7.96 * 86_400_000), NOW)).toBe(
      7,
    );
  });
});

describe("assess", () => {
  const opts = { now: NOW, maxAgeDays: 8 };

  it("is quiet when the check ran this week", () => {
    const a = assess({ runs: [run({ run_started_at: daysAgo(6) })], ...opts });
    expect(a.stale).toBe(false);
    expect(a.reason).toBeNull();
    expect(a.ageDays).toBe(6);
  });

  it("says nothing has ever run when nothing has", () => {
    const a = assess({ runs: [], ...opts });
    expect(a.stale).toBe(true);
    expect(a.reason).toBe("never-ran");
    expect(a.ageDays).toBeNull();
  });

  it("tells a missed Monday from a broken check", () => {
    // Silence: the last run is the last success, and both are too old.
    const quiet = assess({
      runs: [run({ run_started_at: daysAgo(9) })],
      ...opts,
    });
    expect(quiet.reason).toBe("too-old");

    // Noise: it ran yesterday and failed, so there is a red tick to look at.
    const broken = assess({
      runs: [
        run({ run_started_at: daysAgo(1), conclusion: "failure" }),
        run({ run_started_at: daysAgo(9) }),
      ],
      ...opts,
    });
    expect(broken.reason).toBe("failing");
    expect(broken.lastRunConclusion).toBe("failure");
  });

  it("does not count a failure as a report", () => {
    const a = assess({
      runs: [run({ run_started_at: daysAgo(1), conclusion: "failure" })],
      ...opts,
    });
    expect(a.stale).toBe(true);
    expect(a.reason).toBe("never-passed");
  });

  it("holds its nerve on the boundary", () => {
    // Eight days is a week plus the slack, and is not yet a missed Monday.
    expect(
      assess({ runs: [run({ run_started_at: daysAgo(8) })], ...opts }).stale,
    ).toBe(false);
    expect(
      assess({ runs: [run({ run_started_at: daysAgo(9) })], ...opts }).stale,
    ).toBe(true);
  });

  it("finds the newest success whatever order it arrives in", () => {
    const a = assess({
      runs: [
        run({ run_started_at: daysAgo(30) }),
        run({ run_started_at: daysAgo(2) }),
        run({ run_started_at: daysAgo(16) }),
      ],
      ...opts,
    });
    expect(a.stale).toBe(false);
    expect(a.ageDays).toBe(2);
  });

  it("ignores a run with no start time rather than throwing", () => {
    const a = assess({
      runs: [{ conclusion: "success" }, run({ run_started_at: daysAgo(3) })],
      ...opts,
    });
    expect(a.stale).toBe(false);
    expect(a.ageDays).toBe(3);
  });

  it("looks past a queued run to the last one that finished", () => {
    const a = assess({
      runs: [
        run({ run_started_at: daysAgo(0), conclusion: null }),
        run({ run_started_at: daysAgo(20) }),
      ],
      ...opts,
    });
    expect(a.stale).toBe(true);
    expect(a.reason).toBe("failing");
  });
});

describe("buildNotice", () => {
  const notice = (runs: ReturnType<typeof run>[]) =>
    buildNotice({
      assessment: assess({ runs, now: NOW, maxAgeDays: 8 }),
      maxAgeDays: 8,
      repo: "o/r",
      workflow: "health.yml",
    });

  it("says when it last worked and how to get the report now", () => {
    const body = notice([run({ run_started_at: daysAgo(9) })]);
    expect(body).toContain("has not run");
    expect(body).toContain("9 days");
    expect(body).toContain(
      "https://github.com/o/r/actions/workflows/health.yml",
    );
    expect(body).toContain("closes itself");
  });

  it("does not blame the check when the check never ran", () => {
    const body = notice([run({ run_started_at: daysAgo(9) })]);
    expect(body).toContain("drops what it cannot get to");
  });

  it("says something different when it ran and failed", () => {
    const body = notice([
      run({ run_started_at: daysAgo(1), conclusion: "failure" }),
      run({ run_started_at: daysAgo(9) }),
    ]);
    expect(body).toContain("not passing");
    expect(body).toContain("the logs will say why");
    expect(body).not.toContain("drops what it cannot get to");
  });

  it("copes with never having succeeded at all", () => {
    const body = notice([]);
    expect(body).toContain("no successful run");
    expect(body).not.toContain("NaN");
  });
});
