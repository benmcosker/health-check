/**
 * Decide whether the weekly health check has gone missing.
 *
 * The thing this watches for cannot be seen from inside it. A scheduled
 * workflow that does not fire produces no run, no annotation and no red tick -
 * GitHub queues every repository's schedules together and drops what it cannot
 * reach, silently, either way. So the only evidence is an absence, and absence
 * has to be looked for on purpose by something else.
 *
 * Split from watchdog-check.mjs on the same grounds as health-report.mjs: the
 * judgement lives here where a test can reach it without a network.
 *
 * Knows nothing about which project it watches or what it calls its workflow;
 * both arrive as arguments.
 */

/** Whole days between two instants, floored - a run 7.9 days old is 7. */
export function daysBetween(then, now) {
  const ms = now.getTime() - new Date(then).getTime();
  return Math.floor(ms / 86_400_000);
}

/** Runs come back newest first, but order is the API's promise, not ours. */
function newest(runs) {
  return [...runs]
    .filter((r) => r && typeof r.run_started_at === "string")
    .sort(
      (a, b) =>
        new Date(b.run_started_at).getTime() -
        new Date(a.run_started_at).getTime(),
    );
}

/**
 * What the run history says, in the four shapes it can take.
 *
 * "Ran and failed" is kept apart from "did not run" because they want
 * different things doing. A failure already shows up as a red tick somebody
 * may act on; a run that never happened shows up as nothing at all, and is the
 * whole reason this exists.
 */
export function assess({ runs, now, maxAgeDays }) {
  const ordered = newest(runs ?? []);
  const lastRun = ordered[0] ?? null;
  const lastSuccess = ordered.find((r) => r.conclusion === "success") ?? null;

  const common = {
    lastRunAt: lastRun?.run_started_at ?? null,
    lastRunConclusion: lastRun?.conclusion ?? null,
    lastRunUrl: lastRun?.html_url ?? null,
    lastSuccessAt: lastSuccess?.run_started_at ?? null,
    ageDays: lastSuccess ? daysBetween(lastSuccess.run_started_at, now) : null,
  };

  if (!lastRun) return { ...common, stale: true, reason: "never-ran" };
  if (!lastSuccess) return { ...common, stale: true, reason: "never-passed" };
  if (common.ageDays > maxAgeDays) {
    // A recent failure is a different story from a recent silence, even though
    // both leave the last success stranded in the past.
    const failedSince =
      lastRun !== lastSuccess &&
      daysBetween(lastRun.run_started_at, now) <= maxAgeDays;
    return {
      ...common,
      stale: true,
      reason: failedSince ? "failing" : "too-old",
    };
  }
  return { ...common, stale: false, reason: null };
}

const HEADLINE = {
  "never-ran": "The weekly health check has never run.",
  "never-passed": "The weekly health check has never finished successfully.",
  "too-old": "The weekly health check has not run.",
  failing: "The weekly health check is running but not passing.",
};

/**
 * The issue body.
 *
 * It says how to get the report by hand, because the useful response to "the
 * scheduler dropped it" is to ask for it rather than to wait another week.
 */
export function buildNotice({ assessment, maxAgeDays, repo, workflow }) {
  const { reason, ageDays, lastSuccessAt, lastRunAt, lastRunConclusion } =
    assessment;
  const actions = `https://github.com/${repo}/actions/workflows/${workflow}`;

  const lines = [`_${HEADLINE[reason]}_`, ""];

  if (lastSuccessAt) {
    lines.push(
      `Last successful run: **${lastSuccessAt.slice(0, 10)}**, ${ageDays} days ` +
        `ago. Anything over ${maxAgeDays} days means a Monday was missed.`,
      "",
    );
  } else {
    lines.push(
      `There is no successful run of \`${workflow}\` on record at all.`,
      "",
    );
  }

  if (reason === "failing") {
    lines.push(
      `It did run on ${lastRunAt.slice(0, 10)} and finished \`${lastRunConclusion}\`, ` +
        `so this is a broken check rather than a missed one - the logs will say why.`,
      "",
    );
  } else {
    lines.push(
      "Most likely nothing is broken. GitHub runs every repository's scheduled",
      "workflows off one queue and drops what it cannot get to, with no",
      "notification either way. The run did not happen, so there is no failure",
      "to look at - which is exactly why this issue exists.",
      "",
    );
  }

  lines.push(
    "**Get this week's report now:** run the workflow by hand from",
    `[Actions → ${workflow}](${actions}) (Run workflow). It takes about`,
    "a minute and files the usual report.",
    "",
    "This issue closes itself once a successful run appears.",
  );

  return lines.join("\n");
}
