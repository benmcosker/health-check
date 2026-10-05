import { describe, expect, it } from "vitest";

import {
  bump,
  buildReport,
  daysUntil,
  needsAttention,
  summariseAudit,
  summariseCredentials,
  summariseOutdated,
  summariseRuntimes,
  // Plain JS, so the workflow can run it straight after npm ci.
} from "../src/health-report.mjs";

const advisory = (over = {}) => ({
  severity: "high",
  isDirect: false,
  fixAvailable: true,
  ...over,
});

describe("bump", () => {
  it("tells a project apart from a chore", () => {
    expect(bump("1.2.3", "2.0.0")).toBe("major");
    expect(bump("1.2.3", "1.3.0")).toBe("minor");
    expect(bump("1.2.3", "1.2.4")).toBe("patch");
  });

  it("has nothing to say when nothing moved", () => {
    expect(bump("1.2.3", "1.2.3")).toBeNull();
    expect(bump(undefined, "1.2.3")).toBeNull();
  });

  it("copes with a leading range character", () => {
    // npm reports "current" bare but a package.json range is "^1.2.3".
    expect(bump("^1.2.3", "2.0.0")).toBe("major");
  });
});

describe("summariseAudit", () => {
  const audit = {
    vulnerabilities: {
      next: advisory({ severity: "critical", isDirect: true }),
      eslint: advisory({ severity: "high" }),
      chalk: advisory({ severity: "low" }),
    },
  };

  it("reports moderate and above, and leaves the noise out", () => {
    const summary = summariseAudit(audit, { vulnerabilities: {} });
    expect(summary.total).toBe(3);
    expect(summary.reportable.map((a: { name: string }) => a.name)).toEqual([
      "next",
      "eslint",
    ]);
  });

  /*
   * The number that decides whether a Monday matters. Reaching a dev-only
   * advisory means running the toolchain; reaching a production one means
   * sending a request, and those deserve different urgency.
   */
  it("counts separately what a request could reach", () => {
    const summary = summariseAudit(audit, {
      vulnerabilities: { next: advisory({ severity: "critical" }) },
    });
    expect(summary.production.map((a: { name: string }) => a.name)).toEqual([
      "next",
    ]);
  });

  it("marks a fix that is itself a major, because that is not a Tuesday job", () => {
    const summary = summariseAudit(
      {
        vulnerabilities: {
          prisma: advisory({ fixAvailable: { isSemVerMajor: true } }),
        },
      },
      {},
    );
    expect(summary.reportable[0].breaking).toBe(true);
  });

  it("says when there is no fix to apply yet", () => {
    const summary = summariseAudit(
      { vulnerabilities: { sharp: advisory({ fixAvailable: false }) } },
      {},
    );
    expect(summary.reportable[0].fixable).toBe(false);
  });

  /*
   * This used to assert `total` was 0 here, which is how the bug lived: npm
   * saying nothing and npm saying "nothing is wrong" are different facts, and
   * reading the first as the second is a report that lies on exactly the week
   * it matters. Still must not throw - that part was always right.
   */
  it("treats npm saying nothing at all as unknown, not as clear", () => {
    expect(summariseAudit({}, {}).total).toBeNull();
    expect(summariseAudit({}, {}).state).toBe("unknown");
    expect(summariseAudit(undefined, undefined).reportable).toEqual([]);
    expect(summariseAudit(undefined, undefined).state).toBe("unknown");
  });
});

describe("needsAttention", () => {
  const clear = {
    audit: { reportable: [], production: [], total: 0 },
    outdated: { major: [], minor: [], patch: [] },
    drift: false,
  };

  it("stays quiet when there is nothing to do", () => {
    expect(needsAttention(clear)).toBe(false);
  });

  /*
   * Patches alone are not worth an issue. They arrive constantly, npm audit
   * speaks up when one of them matters, and a weekly notice nobody needs to
   * act on is how people learn to skip the notice that does matter.
   */
  it("does not wake anybody for patch releases alone", () => {
    expect(
      needsAttention({
        ...clear,
        outdated: { major: [], minor: [], patch: [{}, {}] },
      }),
    ).toBe(false);
  });

  it("speaks up for drift, advisories or a real version gap", () => {
    expect(needsAttention({ ...clear, drift: true })).toBe(true);
    expect(
      needsAttention({ ...clear, audit: { ...clear.audit, reportable: [{}] } }),
    ).toBe(true);
    expect(
      needsAttention({
        ...clear,
        outdated: { major: [{}], minor: [], patch: [] },
      }),
    ).toBe(true);
  });
});

describe("buildReport", () => {
  const report = {
    audit: summariseAudit(
      {
        vulnerabilities: {
          next: advisory({ severity: "critical", isDirect: true }),
        },
      },
      { vulnerabilities: { next: advisory() } },
    ),
    outdated: summariseOutdated({
      typescript: { current: "5.9.3", latest: "7.0.2" },
      zod: { current: "4.4.3", latest: "4.5.4" },
    }),
    drift: true,
    versions: { node: "v22.22.2" },
    date: "2026-09-09",
  };

  it("names the advisory, the majors and the drift", () => {
    const body = buildReport(report);
    expect(body).toContain("**next** - critical, direct dependency");
    expect(body).toContain("**typescript** 5.9.3 → 7.0.2");
    expect(body).toContain("- zod 4.4.3 → 4.5.4");
    expect(body).toContain("**Drift**");
  });

  it("says so plainly when the schema is fine", () => {
    expect(buildReport({ ...report, drift: false })).toContain(
      "Migrations match the schema",
    );
  });

  it("writes _None._ rather than an empty heading", () => {
    const empty = {
      ...report,
      audit: summariseAudit({}, {}),
      outdated: summariseOutdated({}),
    };
    expect(buildReport(empty)).toContain("_None._");
  });
});

const TODAY = new Date("2026-09-09T00:00:00.000Z");

describe("daysUntil", () => {
  it("counts forward and back", () => {
    expect(daysUntil("2026-09-19", TODAY)).toBe(10);
    expect(daysUntil("2026-08-30", TODAY)).toBe(-10);
  });
});

describe("summariseRuntimes", () => {
  const runtimes = [{ product: "nodejs", cycle: "22", used: "Vercel" }];

  it("says how long is left when the end is in sight", () => {
    const [only] = summariseRuntimes(
      runtimes,
      { "nodejs/22": { eol: "2026-11-08" } },
      TODAY,
      180,
    );
    expect(only.state).toBe("soon");
    expect(only.days).toBe(60);
  });

  it("says when support has already ended", () => {
    const [only] = summariseRuntimes(
      runtimes,
      { "nodejs/22": { eol: "2026-01-01" } },
      TODAY,
      180,
    );
    expect(only.state).toBe("ended");
  });

  it("is quiet about a date comfortably far off", () => {
    const [only] = summariseRuntimes(
      runtimes,
      { "nodejs/22": { eol: "2028-04-30" } },
      TODAY,
      180,
    );
    expect(only.state).toBe("supported");
  });

  it("handles a cycle with no announced end", () => {
    // endoflife.date answers `false` rather than a date for these.
    const [only] = summariseRuntimes(
      runtimes,
      { "nodejs/22": { eol: false } },
      TODAY,
      180,
    );
    expect(only.state).toBe("supported");
    expect(only.eol).toBeNull();
  });

  /*
   * The important one. A lookup that fails must not read as "fine" - a check
   * that silently answers nothing every week is worse than no check, because
   * it looks like one.
   */
  it("says it could not check, rather than nothing", () => {
    const [only] = summariseRuntimes(runtimes, {}, TODAY, 180);
    expect(only.state).toBe("unknown");
    expect(
      needsAttention({
        audit: { reportable: [], production: [], total: 0 },
        outdated: { major: [], minor: [], patch: [] },
        drift: false,
        runtimes: [only],
      }),
    ).toBe(true);
  });
});

describe("summariseCredentials", () => {
  it("ages a recorded rotation", () => {
    const [only] = summariseCredentials(
      [{ name: "T", rotatedOn: "2026-08-10", everyDays: 365 }],
      TODAY,
    );
    expect(only.age).toBe(30);
    expect(only.state).toBe("current");
  });

  it("calls it overdue past its own interval", () => {
    const [only] = summariseCredentials(
      [{ name: "T", rotatedOn: "2025-01-01", everyDays: 365 }],
      TODAY,
    );
    expect(only.state).toBe("overdue");
  });

  /*
   * A missing date is reported and never raises the alarm. A weekly notice
   * about a form nobody has filled in is how somebody learns to skip the
   * notice that matters; an overdue rotation is a fact about the world and
   * does raise it.
   */
  it("reports a missing date without opening an issue for it", () => {
    const clear = {
      audit: { reportable: [], production: [], total: 0 },
      outdated: { major: [], minor: [], patch: [] },
      drift: false,
    };
    const unrecorded = summariseCredentials(
      [{ name: "T", rotatedOn: null, everyDays: 365 }],
      TODAY,
    );
    expect(unrecorded[0].state).toBe("unrecorded");
    expect(needsAttention({ ...clear, credentials: unrecorded })).toBe(false);

    const overdue = summariseCredentials(
      [{ name: "T", rotatedOn: "2020-01-01", everyDays: 365 }],
      TODAY,
    );
    expect(needsAttention({ ...clear, credentials: overdue })).toBe(true);
  });
});

/*
 * The two corrections to what npm reports. npm knows what is published and
 * what is installed; it does not know what we run or what we import, and on
 * both counts it told this report something false.
 */
describe("packages held to a track", () => {
  // The real shape: @types/node on ^22, with 26 published.
  const outdated = {
    "@types/node": { current: "22.20.4", wanted: "22.20.4", latest: "26.6.2" },
    eslint: { current: "9.39.5", wanted: "9.39.5", latest: "10.11.0" },
  };
  const pinned = [{ package: "@types/node", track: "22" }];

  it("says nothing about a pinned package at the top of its track", () => {
    const summary = summariseOutdated(outdated, pinned);
    expect(summary.major.map((r: { name: string }) => r.name)).toEqual([
      "eslint",
    ]);
    expect(summary.pinned).toEqual([]);
  });

  it("still reports one that has fallen behind inside its track", () => {
    // Muting the package would hide this; measuring against the track does not.
    const behind = {
      "@types/node": {
        current: "22.1.0",
        wanted: "22.20.4",
        latest: "26.6.2",
      },
    };
    const summary = summariseOutdated(behind, pinned);
    expect(summary.minor).toHaveLength(1);
    expect(summary.minor[0].latest).toBe("22.20.4");
    expect(summary.minor[0].pinnedTo).toBe("22");
    expect(summary.minor[0].published).toBe("26.6.2");
  });

  it("reports the whole jump when nothing is pinned", () => {
    // Without the pin this is the wrong advice the check used to give.
    const summary = summariseOutdated(outdated);
    expect(summary.major.map((r: { name: string }) => r.name)).toEqual([
      "@types/node",
      "eslint",
    ]);
  });

  it("names the track on the line that raises it", () => {
    const body = buildReport({
      audit: { reportable: [], production: [], demoted: [], total: 0 },
      outdated: summariseOutdated(
        { "@types/node": { current: "22.1.0", wanted: "22.20.4" } },
        pinned,
      ),
      drift: false,
      versions: {},
      date: "2026-09-19",
    });
    expect(body).toContain("held to 22.x");
  });
});

describe("advisories npm calls production and a person checked", () => {
  const audit = {
    vulnerabilities: {
      next: advisory({ severity: "critical", isDirect: true }),
      prisma: advisory({ severity: "high", isDirect: true }),
    },
  };
  // npm's --omit=dev tree keeps optional peers, so the CLI lands here too.
  const prodAudit = {
    vulnerabilities: { next: advisory(), prisma: advisory() },
  };
  const unreachable = [
    { package: "prisma", checkedOn: "2026-09-19", why: "The CLI." },
  ];

  it("stops counting one that nothing imports", () => {
    const summary = summariseAudit(audit, prodAudit, unreachable);
    expect(summary.production.map((a: { name: string }) => a.name)).toEqual([
      "next",
    ]);
    expect(summary.demoted.map((a: { name: string }) => a.name)).toEqual([
      "prisma",
    ]);
  });

  it("still reports it, rather than hiding it", () => {
    // A silent exception is how a real finding gets suppressed for a year.
    const summary = summariseAudit(audit, prodAudit, unreachable);
    expect(summary.reportable).toHaveLength(2);
    expect(summary.total).toBe(2);
  });

  it("does not demote a package nobody wrote down", () => {
    const summary = summariseAudit(audit, prodAudit, []);
    expect(summary.production).toHaveLength(2);
    expect(summary.demoted).toEqual([]);
  });

  it("says once, under the list, which lines were corrected", () => {
    const body = buildReport({
      audit: summariseAudit(audit, prodAudit, unreachable),
      outdated: { major: [], minor: [], patch: [] },
      drift: false,
      versions: {},
      date: "2026-09-19",
    });
    expect(body).toContain("2 at moderate or above, 1 of those reachable");
    expect(body).toContain("checked by hand");
    expect(body).toContain("`lifecycle.json`");
  });
});

/*
 * The failure this file exists to prevent: a week where nobody looked,
 * reported as a week where nothing was wrong. `npm audit` writes an error
 * object instead of a report when the registry refuses it, and the workflow
 * cannot tell that from success, because a successful audit also exits
 * non-zero whenever it finds something.
 */
describe("an audit that did not answer", () => {
  // The real shape, from a 400 the registry returned on 19 September 2026.
  const failed = {
    message:
      "400 Bad Request - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick - Bad Request",
    method: "POST",
  };
  const clear = {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: { high: 0 } },
  };

  it("is unknown, and unknown is not zero", () => {
    const summary = summariseAudit(failed, failed);
    expect(summary.state).toBe("unknown");
    expect(summary.total).toBeNull();
    expect(summary.reportable).toEqual([]);
  });

  it("opens the issue rather than closing it", () => {
    // The whole point. Without this the workflow comments "Clear this week"
    // and closes, on a week it learned nothing.
    const report = {
      audit: summariseAudit(failed, failed),
      outdated: { major: [], minor: [], patch: [] },
      drift: false,
    };
    expect(needsAttention(report)).toBe(true);
  });

  it("still lets a genuinely clear week close the issue", () => {
    // The fix must not make the issue immortal - that is the same noise
    // problem wearing the opposite hat.
    const report = {
      audit: summariseAudit(clear, clear),
      outdated: { major: [], minor: [], patch: [] },
      drift: false,
    };
    expect(summariseAudit(clear, clear).state).toBe("ok");
    expect(needsAttention(report)).toBe(false);
  });

  it("says so in the body instead of printing an empty list", () => {
    const body = buildReport({
      audit: summariseAudit(failed, failed),
      outdated: { major: [], minor: [], patch: [] },
      drift: false,
      versions: {},
      date: "2026-09-19",
    });
    expect(body).toContain("Could not check");
    // "_None._" under this heading would be the claim we just refused to make.
    expect(body).not.toContain("_None._\n\n## Behind");
  });

  it("catches the quieter half: the production audit failing alone", () => {
    // Every advisory would otherwise read "build-time only", which looks like
    // a complete answer and is not one.
    const audit = {
      vulnerabilities: { next: advisory({ severity: "critical" }) },
      metadata: { vulnerabilities: { critical: 1 } },
    };
    const summary = summariseAudit(audit, failed);
    expect(summary.state).toBe("ok");
    expect(summary.reachabilityKnown).toBe(false);
    expect(summary.production).toEqual([]);
    expect(summary.reportable[0].reachable).toBeNull();
    expect(
      needsAttention({
        audit: summary,
        outdated: { major: [], minor: [], patch: [] },
        drift: false,
      }),
    ).toBe(true);

    const body = buildReport({
      audit: summary,
      outdated: { major: [], minor: [], patch: [] },
      drift: false,
      versions: {},
      date: "2026-09-19",
    });
    expect(body).toContain("unknown this week");
  });
});

describe("buildReport for a project that has not configured everything", () => {
  const base = {
    audit: summariseAudit(
      { vulnerabilities: {}, metadata: {} },
      { vulnerabilities: {} },
    ),
    outdated: summariseOutdated({}),
    versions: { node: "v22.0.0" },
    date: "2026-10-05",
  };

  it("leaves out the Schema section for a project with no drift check", () => {
    // `null` means "this project does not look", which is not "looked and
    // found nothing". Printing 'Migrations match the schema' for a project
    // with no migrations would be a small lie in the one place people skim.
    const body = buildReport({ ...base, drift: null });
    expect(body).not.toContain("## Schema");
    expect(body).not.toContain("Migrations match");
  });

  it("says drift is clean only when it was checked and was", () => {
    expect(buildReport({ ...base, drift: false })).toContain(
      "Migrations match the schema.",
    );
  });

  it("uses the project's own words for what drift means", () => {
    const body = buildReport({
      ...base,
      drift: true,
      driftNote: "`db/schema.sql` and the migrations disagree.",
    });
    expect(body).toContain(
      "**Drift**: `db/schema.sql` and the migrations disagree.",
    );
  });

  it("says an empty runtimes or credentials section is not configured, not clear", () => {
    // "None." under Runtimes reads as good news. On a project that never
    // listed a runtime it is the absence of a question.
    const body = buildReport({ ...base, drift: null });
    expect(body).toContain("_Not configured._ List the runtimes");
    expect(body).toContain("_Not configured._ List secrets");
    expect(body).not.toContain("Rotation dates are kept by hand");
  });

  it("only treats a definite drift as a reason to open the issue", () => {
    const quiet = {
      audit: base.audit,
      outdated: base.outdated,
    };
    expect(needsAttention({ ...quiet, drift: null })).toBe(false);
    expect(needsAttention({ ...quiet, drift: false })).toBe(false);
    expect(needsAttention({ ...quiet, drift: true })).toBe(true);
    // And leaving it out entirely is the same as not checking.
    expect(needsAttention(quiet)).toBe(false);
  });
});
