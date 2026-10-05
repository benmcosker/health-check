/**
 * The watchdog's entry point: ask GitHub when the weekly check last passed.
 *
 * Deliberately thin, and deliberately without dependencies. This job has no
 * `npm ci`, no database, no build and no packages - it is the thing that has
 * to keep working when the thing it watches does not, so it shares as little
 * as possible with it. Node's own fetch and nothing else.
 */
import { appendFileSync } from "node:fs";

import { assess, buildNotice } from "./watchdog-report.mjs";

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const workflow = process.env.WATCH_WORKFLOW ?? "health.yml";
const maxAgeDays = Number(process.env.MAX_AGE_DAYS ?? 8);

if (!repo || !token) {
  console.error("GITHUB_REPOSITORY and GITHUB_TOKEN are both required.");
  process.exit(2);
}

/**
 * "Could not check" is not "nothing to report".
 *
 * `summariseAudit` learned this the hard way and it applies twice over here:
 * a watchdog that answers "all clear" when it could not reach the API is
 * worse than no watchdog, because it is reassuring. An unanswered question
 * exits non-zero, which shows up as the red tick this job is otherwise for.
 */
async function listRuns() {
  /*
   * Every run counts, not just the scheduled ones. What matters is whether a
   * report arrived, and a report somebody asked for by hand is still a report.
   * Filtering to `event=schedule` would keep this issue open all week after
   * the obvious remedy had already been applied.
   */
  const url =
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs` +
    `?per_page=20`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${workflow} runs`);
  }
  return (await response.json()).workflow_runs ?? [];
}

let runs;
try {
  runs = await listRuns();
} catch (error) {
  console.error(`[watchdog] could not check: ${error.message}`);
  process.exit(1);
}

const assessment = assess({ runs, now: new Date(), maxAgeDays });
const body = assessment.stale
  ? buildNotice({ assessment, maxAgeDays, repo, workflow })
  : "";

const out = process.env.GITHUB_OUTPUT;
if (out) {
  const eof = `EOF_${Math.random().toString(36).slice(2)}`;
  appendFileSync(out, `stale=${assessment.stale}\n`);
  appendFileSync(out, `body<<${eof}\n${body}\n${eof}\n`);
}

console.log(
  assessment.stale
    ? body
    : `Last successful ${workflow} run was ${assessment.ageDays} days ago.`,
);
