/**
 * The entry point: read what the tools produced, write the report.
 *
 * Split from health-report.mjs so the judgement calls in there can be tested
 * without a filesystem, and so this file stays a matter of plumbing.
 *
 * Runs against the PROJECT being checked, not against this repository. Every
 * path is resolved from the project directory (the working directory unless
 * HEALTH_PROJECT_DIR says otherwise); nothing is read from next to this file
 * except the code itself.
 *
 * Environment:
 *   HEALTH_PROJECT_DIR  the project to check                (default: cwd)
 *   HEALTH_LIFECYCLE    path to its config, relative to it  (default: lifecycle.json, optional)
 *   HEALTH_AUDIT        npm audit --json output
 *   HEALTH_AUDIT_PROD   npm audit --omit=dev --json output
 *   HEALTH_OUTDATED     npm outdated --json output
 *   DRIFT               "true" / "false", or empty when the project has no drift check
 *   DRIFT_NOTE          what drift means for this project, in a sentence
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateConfig, withDefaults } from "./config.mjs";
import {
  buildReport,
  needsAttention,
  summariseAudit,
  summariseCredentials,
  summariseOutdated,
  summariseRuntimes,
} from "./health-report.mjs";

/** A message and a non-zero exit: this is a setup mistake, not a finding. */
function stop(message) {
  console.error(`[health] ${message}`);
  process.exit(2);
}

/** npm writes nothing when it has nothing to say, and that is not an error. */
function readJson(path) {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

const dir = resolve(process.env.HEALTH_PROJECT_DIR || process.cwd());
const at = (...parts) => resolve(dir, ...parts);

if (!existsSync(at("package.json"))) {
  stop(`No package.json in ${dir}. This check is for npm projects.`);
}

/*
 * `npm outdated` compares what package.json asks for with what is installed.
 * With nothing installed there is nothing to compare, `current` comes back
 * empty, and every package reads as not behind - a report that says the
 * project is fully up to date because it never looked. So refuse, loudly.
 * Running `npm ci` first is the caller's job and is one line.
 */
if (!existsSync(at("node_modules"))) {
  stop(
    `No node_modules in ${dir}. Run \`npm ci\` before this step: without it ` +
      "`npm outdated` has nothing to compare and reports everything as current.",
  );
}

const explicit = process.env.HEALTH_LIFECYCLE;
const configPath = at(explicit || "lifecycle.json");
if (explicit && !existsSync(configPath)) {
  stop(`HEALTH_LIFECYCLE points at ${configPath}, which does not exist.`);
}
const raw = existsSync(configPath) ? readJson(configPath) : {};
const problems = validateConfig(raw);
if (problems.length) {
  stop(
    `${configPath} has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n` +
      problems.map((p) => `  - ${p}`).join("\n"),
  );
}
const lifecycle = withDefaults(raw);

const pkg = readJson(at("package.json"));

/**
 * Support dates, asked for rather than remembered.
 *
 * A date copied into the repo is wrong the first time upstream moves it and
 * nobody re-reads a constant. A lookup that fails returns nothing for that
 * runtime, which the report says out loud - "could not check" and "fine" are
 * different answers and only one of them deserves silence.
 */
async function fetchEol(runtimes) {
  const found = {};
  for (const r of runtimes) {
    const key = `${r.product}/${r.cycle}`;
    try {
      const res = await fetch(`https://endoflife.date/api/${key}.json`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) found[key] = await res.json();
      else console.error(`[health] ${key}: HTTP ${res.status}`);
    } catch (error) {
      console.error(`[health] ${key}: ${error.message}`);
    }
  }
  return found;
}

const today = new Date();

const runtimes = summariseRuntimes(
  lifecycle.runtimes,
  await fetchEol(lifecycle.runtimes),
  today,
  lifecycle.warnWithinDays,
);
const credentials = summariseCredentials(lifecycle.credentials, today);

const audit = summariseAudit(
  readJson(process.env.HEALTH_AUDIT ?? "/dev/null"),
  readJson(process.env.HEALTH_AUDIT_PROD ?? "/dev/null"),
  lifecycle.unreachable,
);
const outdated = summariseOutdated(
  readJson(process.env.HEALTH_OUTDATED ?? "/dev/null"),
  lifecycle.pinned,
);

// Empty means this project has no drift check, which is not the same as
// "checked and clean". Only the two words say anything.
const drift =
  process.env.DRIFT === "true"
    ? true
    : process.env.DRIFT === "false"
      ? false
      : null;

// The runtime, then whichever packages this project said it cares about.
const declared = (name) =>
  pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? "unknown";
const versions = {
  node: process.version,
  ...Object.fromEntries(lifecycle.versions.map((n) => [n, declared(n)])),
};

const report = {
  audit,
  outdated,
  drift,
  driftNote: process.env.DRIFT_NOTE || undefined,
  runtimes,
  credentials,
  versions,
  date: today.toISOString().slice(0, 10),
};

const needed = needsAttention(report);
const body = buildReport(report);

// Multi-line values need a delimiter GitHub will not find in the content.
const out = process.env.GITHUB_OUTPUT;
if (out) {
  const eof = `EOF_${Math.random().toString(36).slice(2)}`;
  appendFileSync(out, `needed=${needed}\n`);
  appendFileSync(out, `body<<${eof}\n${body}\n${eof}\n`);
}

console.log(needed ? body : "Nothing to report.");
