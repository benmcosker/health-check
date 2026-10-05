/**
 * Turning a week of rot into something worth reading.
 *
 * CI already runs on every push, so it answers "did this commit break
 * anything". Nothing in it answers "did the world move while we were not
 * looking" - a CVE published against a dependency nobody touched, a package
 * three majors behind, a schema that drifted from its migrations. That is what
 * this summarises.
 *
 * Plain JS with no dependencies so a workflow can run it straight after
 * `npm ci` without a build step, and exported rather than inlined so the
 * judgement calls below are testable.
 *
 * Shared by every project that uses this repo, so nothing here may know what
 * a project is called, which ORM it uses or which framework it runs. What
 * differs per project is data, in the project's own `lifecycle.json`.
 */

/** Severities worth waking somebody for, worst first. */
export const REPORTABLE = ["critical", "high", "moderate"];

/**
 * Advisories, split by whether they can reach production.
 *
 * `prod` comes from a second `npm audit --omit=dev` rather than from guessing
 * at the tree: reaching a dev-only advisory means running the toolchain rather
 * than sending a request, and "8 advisories" and "1 a stranger could reach"
 * are different sentences deserving different Mondays. Guessing which was
 * which from the node paths was the first version of this, and it was wrong
 * often enough not to keep.
 *
 * `--omit=dev` is still not the same question as "could a request reach this".
 * npm keeps optional peer dependencies in that tree, so a command-line tool
 * installed as a devDependency - the Prisma CLI, in the project this came from
 * - counts as production, and drags everything underneath it along. Four of
 * eight advisories were labelled that way and none of them was reachable. There is no cheap
 * way to compute the difference: npm's tree is flattened by the time it is
 * printed, so the peer edge that caused it is gone. So the correction is
 * written down instead, in `lifecycle.json`'s `unreachable`, with a reason and
 * a date per entry - the same bargain as the credential dates. A demoted
 * advisory is still reported; it just stops being counted as something a
 * stranger could reach.
 */
export function ran(audit) {
  return Boolean(audit) && typeof audit.vulnerabilities === "object";
}

export function summariseAudit(audit, prodAudit, unreachable = []) {
  // A lookup that failed is not a clean bill of health. `npm audit` writes an
  // error object rather than a report when the registry refuses it, and the
  // workflow's `|| true` - which is there because a *successful* audit exits
  // non-zero whenever it finds anything - means nothing else notices. Read
  // that as an empty report and the week says "no advisories" on a week
  // nobody looked, which is the one failure this file exists to prevent.
  if (!ran(audit)) {
    return {
      state: "unknown",
      reachabilityKnown: false,
      total: null,
      reportable: [],
      production: [],
      demoted: [],
      counts: {},
    };
  }

  // The second audit can fail on its own, and then every advisory would read
  // "build-time only" - a quieter version of the same lie, and the more
  // dangerous one because the list still looks complete.
  const reachabilityKnown = ran(prodAudit);

  const entries = Object.entries(audit.vulnerabilities);
  const inProd = new Set(Object.keys(prodAudit?.vulnerabilities ?? {}));
  const checked = new Map(unreachable.map((u) => [u.package, u]));

  const advisories = entries.map(([name, v]) => {
    const prod = inProd.has(name);
    const exempt = checked.get(name);
    return {
      name,
      severity: v.severity,
      direct: Boolean(v.isDirect),
      // npm reports `true`, `false`, or an object describing the fix.
      fixable: v.fixAvailable !== false,
      // A fix that changes a major is not a fix you apply on a Tuesday.
      breaking: Boolean(v.fixAvailable?.isSemVerMajor),
      prod,
      reachabilityKnown,
      // What npm said, minus what somebody checked by hand and wrote down.
      // Unknown when the production audit did not answer: an advisory nobody
      // classified is not an advisory nobody can reach.
      reachable: reachabilityKnown ? prod && exempt === undefined : null,
      demoted: prod && exempt !== undefined ? exempt : null,
    };
  });

  const reportable = advisories.filter((a) => REPORTABLE.includes(a.severity));
  return {
    state: "ok",
    reachabilityKnown,
    total: entries.length,
    reportable,
    production: reportable.filter((a) => a.reachable === true),
    demoted: reportable.filter((a) => a.demoted !== null),
    counts: audit.metadata?.vulnerabilities ?? {},
  };
}

/** Which part of the version moved. A major is a project; a patch is a chore. */
export function bump(current, latest) {
  if (!current || !latest || current === latest) return null;
  const [a, b] = [current, latest].map((v) =>
    String(v)
      .replace(/^[^0-9]*/, "")
      .split(".")
      .map(Number),
  );
  if (a[0] !== b[0]) return "major";
  if (a[1] !== b[1]) return "minor";
  return "patch";
}

/**
 * What is behind, grouped by how much work catching up is.
 *
 * Majors are listed and never counted as routine: this is the number that
 * quietly grows on an app nobody is maintaining, and the whole point of asking
 * weekly is to see it move from two to three rather than to discover it at
 * eleven.
 *
 * Some packages are behind on purpose. `@types/node` tracks the runtime rather
 * than the registry, so "20 → 26" was never the right advice for an app on
 * Node 22 - it is a recommendation to describe APIs that will not be there.
 * Those are listed in `lifecycle.json`'s `pinned` and measured against
 * `wanted`, the newest release inside the package.json range, instead of
 * `latest`. A pinned package that is at the top of its track is not behind at
 * all and says nothing; one that has fallen behind inside its track still
 * reports, which is the point of not simply muting it.
 */
export function summariseOutdated(outdated, pinned = []) {
  const heldTo = new Map(pinned.map((p) => [p.package, p]));

  const rows = Object.entries(outdated ?? {}).flatMap(([name, o]) => {
    const pin = heldTo.get(name);
    const target = pin ? o.wanted : o.latest;
    const kind = bump(o.current, target);
    // Nothing moved, or nothing moved inside the track we hold it to.
    if (!kind) return [];
    return [
      {
        name,
        current: o.current,
        latest: target,
        kind,
        pinnedTo: pin ? pin.track : null,
        // Kept so the report can say what was passed over, and why.
        published: o.latest,
      },
    ];
  });

  return {
    major: rows.filter((r) => r.kind === "major"),
    minor: rows.filter((r) => r.kind === "minor"),
    patch: rows.filter((r) => r.kind === "patch"),
    pinned: rows.filter((r) => r.pinnedTo !== null),
  };
}

/** Whole days from `from` to `to`, negative once `to` is in the past. */
export function daysUntil(to, from) {
  const day = 24 * 60 * 60 * 1000;
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / day);
}

/**
 * How long each runtime has left.
 *
 * The dates are fetched rather than written down: a support date copied into a
 * repo is wrong the first time upstream moves it, and nobody re-reads a
 * constant. A lookup that failed is reported as a failure rather than as
 * "fine" - not knowing and being safe are different, and only one of them is
 * worth silence.
 */
export function summariseRuntimes(runtimes, eol, today, warnWithinDays) {
  return runtimes.map((r) => {
    const found = eol?.[`${r.product}/${r.cycle}`];

    if (found === undefined) {
      return { ...r, state: "unknown" };
    }
    // endoflife.date answers `false` for a cycle with no announced end.
    if (!found.eol) {
      return { ...r, state: "supported", eol: null };
    }

    const days = daysUntil(found.eol, today);
    return {
      ...r,
      eol: found.eol,
      days,
      state: days < 0 ? "ended" : days <= warnWithinDays ? "soon" : "supported",
    };
  });
}

/**
 * How old each secret is.
 *
 * "never recorded" is a real answer and is reported, but it does not raise the
 * alarm on its own: a weekly notice about a form nobody has filled in is how
 * somebody learns to skip the notice that matters. An overdue rotation does
 * raise it, because that is a fact about the world rather than about the file.
 */
export function summariseCredentials(credentials, today) {
  return credentials.map((c) => {
    if (!c.rotatedOn) return { ...c, state: "unrecorded" };

    const age = -daysUntil(c.rotatedOn, today);
    return {
      ...c,
      age,
      state: age > c.everyDays ? "overdue" : "current",
    };
  });
}

/**
 * Is there anything here a person should act on?
 *
 * @param {{
 *   audit: { reportable: unknown[], [k: string]: unknown },
 *   outdated: { major: unknown[], minor: unknown[], [k: string]: unknown },
 *   drift?: boolean | null,
 *   runtimes?: { state: string }[],
 *   credentials?: { state: string }[],
 * }} report
 */
export function needsAttention({
  audit,
  outdated,
  drift = null,
  runtimes = [],
  credentials = [],
}) {
  return (
    // `null` means this project does not check for drift; only a definite
    // `true` is a reason to open the issue.
    drift === true ||
    // An audit that did not answer is a reason to open the issue, not a
    // reason to close it. Same rule as a runtime we could not look up: not
    // knowing and being fine are different answers, and only one of them
    // deserves silence.
    audit.state === "unknown" ||
    audit.reachabilityKnown === false ||
    audit.reportable.length > 0 ||
    outdated.major.length > 0 ||
    outdated.minor.length > 0 ||
    // A runtime we could not look up counts: not knowing is not the same as
    // being fine, and a lookup that quietly fails every week is worthless.
    runtimes.some((r) => ["ended", "soon", "unknown"].includes(r.state)) ||
    credentials.some((c) => c.state === "overdue")
  );
}

const list = (rows, render) =>
  rows.length ? rows.map(render).join("\n") : "_None._";

/**
 * A section nobody configured is not a section with nothing wrong in it.
 * "None." under Runtimes reads as good news; on a project that never listed a
 * runtime it is the absence of a question, and the report should say so.
 */
const configured = (rows, render, hint) =>
  rows.length ? rows.map(render).join("\n") : `_Not configured._ ${hint}`;

/**
 * The issue body.
 *
 * Written to be skimmed in ten seconds by somebody who has not thought about
 * this project all week: what changed, what it would cost to fix, and what can be
 * ignored until next time.
 */
export function buildReport({
  audit,
  outdated,
  drift = null,
  driftNote = "The schema and its migrations disagree. A migration is missing.",
  versions = {},
  date,
  runtimes = [],
  credentials = [],
}) {
  const runtimeLines = configured(
    runtimes,
    (r) => {
      const what = `**${r.product} ${r.cycle}** (${r.used})`;
      if (r.state === "unknown") {
        return `- ${what} - **could not look this up**. endoflife.date did not answer, so this week says nothing about it either way.`;
      }
      if (r.state === "ended") {
        return `- ${what} - **out of support since ${r.eol}**, ${-r.days} days ago.`;
      }
      if (r.state === "soon") {
        return `- ${what} - support ends ${r.eol}, in ${r.days} days.`;
      }
      return `- ${what} - supported${r.eol ? ` until ${r.eol}` : ", no end announced"}.`;
    },
    "List the runtimes this project depends on under `runtimes` in `lifecycle.json`, and their end-of-life dates will be checked weekly.",
  );

  const credentialLines = configured(
    credentials,
    (c) => {
      const what = `**${c.name}** (${c.where})`;
      const note = c.note ? ` ${c.note}` : "";
      if (c.state === "unrecorded") {
        return `- ${what} - no rotation date recorded.${note}`;
      }
      if (c.state === "overdue") {
        return `- ${what} - **${c.age} days old**, past the ${c.everyDays}-day mark.${note}`;
      }
      return `- ${what} - ${c.age} days old.${note}`;
    },
    "List secrets under `credentials` in `lifecycle.json` to be reminded when one is overdue for rotation.",
  );

  const advisories =
    audit.state === "unknown"
      ? ""
      : list(
          audit.reportable,
          (a) =>
            `- **${a.name}** - ${a.severity}${a.direct ? ", direct dependency" : ""}` +
            (a.reachabilityKnown === false
              ? ", **cannot say whether it ships to production**"
              : a.reachable
                ? ", ships to production"
                : a.demoted
                  ? ", build-time only (npm counts it as production; checked by hand)"
                  : ", build-time only") +
            (a.fixable
              ? a.breaking
                ? " · fix available, but it is a major"
                : " · fix available"
              : " · no fix published yet"),
        );

  /*
   * What the section says above the list, and the two ways it can have
   * nothing trustworthy to say. "We looked and found none" and "we could not
   * look" are the same empty list and opposite facts, so they never share a
   * sentence.
   */
  const advisorySummary =
    audit.state === "unknown"
      ? `**Could not check.** \`npm audit\` did not return a report this week, so
this section is not evidence of anything - neither that there are advisories
nor that there are none. The workflow tolerates a non-zero exit because a
successful audit exits non-zero whenever it finds something, which means a
failed one looks the same from outside. Re-run the job; if it keeps failing,
the endpoint or the lockfile is the thing to fix, not this issue.`
      : audit.reachabilityKnown === false
        ? `${audit.total} in the tree, ${audit.reportable.length} at moderate or above. **How many a request
could reach is unknown this week** - the second audit, the one run with
\`--omit=dev\`, did not answer, and without it every line below would claim to
be build-time only.`
        : `${audit.total} in the tree, ${audit.reportable.length} at moderate or above, ${audit.production.length} of those reachable from a request.`;

  // Said once, under the list, rather than repeated against every line.
  const demotedNote = audit.demoted.length
    ? `\n\n<sub>${audit.demoted.length} of these (${audit.demoted
        .map((a) => `\`${a.name}\``)
        .join(", ")}) are reported by \`npm audit --omit=dev\` as production
but are not reachable from a request. Each has a reason and a date in
\`lifecycle.json\`; re-read them rather than trusting this line.</sub>`
    : "";

  // A pinned package says what it is held to, so "why is this behind?" is
  // answered on the line that raises it rather than three files away.
  const moved = (r) =>
    `${r.current} → ${r.latest}` +
    (r.pinnedTo
      ? ` (held to ${r.pinnedTo}.x; ${r.published} is published)`
      : "");

  const majors = list(outdated.major, (r) => `- **${r.name}** ${moved(r)}`);
  const minors = list(outdated.minor, (r) => `- ${r.name} ${moved(r)}`);

  const credentialNote = credentials.length
    ? `

<sub>Rotation dates are kept by hand in \`lifecycle.json\` - no API can say when
somebody last rotated a token. A missing date is reported but never opens this
issue on its own.</sub>`
    : "";

  const schemaSection =
    drift === null
      ? ""
      : `## Schema

${drift ? `**Drift**: ${driftNote}` : "Migrations match the schema."}

`;

  return `_Checked ${date}._ CI covers what a commit breaks; this covers what
time breaks.

## Advisories

${advisorySummary}

${advisories}${demotedNote}

## Behind

${outdated.major.length} major, ${outdated.minor.length} minor, ${outdated.patch.length} patch.

### Majors

${majors}

### Minors

${minors}

${schemaSection}## Runtimes

${runtimeLines}

## Credentials

${credentialLines}${credentialNote}

## Versions

${Object.entries(versions)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n")}

<sub>Patches are left off this list on purpose - they are noise, and \`npm audit\`
already speaks up when one of them matters.</sub>`;
}
