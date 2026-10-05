/**
 * A project's `lifecycle.json`: the things the weekly check watches that no
 * package manager knows about - when a runtime stops being supported, when a
 * secret was last rotated, which advisories somebody has already checked.
 *
 * Validated, because this file is data a person edits by hand and a typo in it
 * fails in the quietest way available. `unreachable` misspelt as `unreachble`
 * is not an error to JavaScript; it is an empty list, and four advisories that
 * were meant to be demoted come back as four things a stranger could reach.
 * Or the other way round: a credential list nobody can see is not loaded, and
 * the report says nothing about rotation. Either way the week looks clean for
 * the wrong reason - the failure this whole tool exists to prevent - so an
 * unknown top-level key or a malformed entry stops the run with a message
 * instead.
 *
 * Strict about the top level and about the fields the report reads. Tolerant
 * of extra fields inside an entry, because those are where people put the
 * notes that explain themselves (`why`, `dueMonth`) and a check that rejects a
 * comment teaches people to stop writing them.
 */

export const KNOWN_KEYS = [
  "$schema",
  "$comment",
  "runtimes",
  "pinned",
  "unreachable",
  "warnWithinDays",
  "credentials",
  "versions",
];

const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isString = (v) => typeof v === "string" && v.length > 0;

/** Entries that must be objects carrying certain non-empty strings. */
function entries(config, key, required, problems) {
  const value = config[key];
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    problems.push(`\`${key}\` must be a list.`);
    return;
  }
  value.forEach((entry, i) => {
    if (!isObject(entry)) {
      problems.push(`\`${key}[${i}]\` must be an object.`);
      return;
    }
    for (const field of required) {
      if (!isString(entry[field])) {
        problems.push(
          `\`${key}[${i}]\` needs a \`${field}\`` +
            (isString(entry.package ?? entry.name ?? entry.product)
              ? ` (on ${entry.package ?? entry.name ?? entry.product})`
              : "") +
            ".",
        );
      }
    }
  });
}

/** What is wrong with this config, as sentences. Empty when it is fine. */
export function validateConfig(config) {
  if (!isObject(config)) return ["The file must contain a JSON object."];

  const problems = [];

  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.includes(key)) {
      problems.push(
        `Unknown key \`${key}\`. Known keys: ${KNOWN_KEYS.filter((k) => !k.startsWith("$")).join(", ")}.`,
      );
    }
  }

  entries(config, "runtimes", ["product", "cycle"], problems);
  entries(config, "pinned", ["package", "track"], problems);
  entries(config, "unreachable", ["package"], problems);
  entries(config, "credentials", ["name"], problems);

  // `cycle` is looked up as a string in an API URL, and 22 !== "22" there.
  (Array.isArray(config.runtimes) ? config.runtimes : []).forEach((r, i) => {
    if (isObject(r) && r.cycle !== undefined && typeof r.cycle !== "string") {
      problems.push(
        `\`runtimes[${i}].cycle\` must be a string like "22", not a number.`,
      );
    }
  });

  (Array.isArray(config.credentials) ? config.credentials : []).forEach(
    (c, i) => {
      if (!isObject(c)) return;
      // `null` is the honest value for "nobody has recorded this yet", and the
      // report has a state for it. Only a present value has to be a date.
      if (
        c.rotatedOn !== undefined &&
        c.rotatedOn !== null &&
        Number.isNaN(Date.parse(c.rotatedOn))
      ) {
        problems.push(
          `\`credentials[${i}].rotatedOn\` is not a date: ${JSON.stringify(c.rotatedOn)}. Use YYYY-MM-DD.`,
        );
      }
      if (c.everyDays !== undefined && !Number.isFinite(c.everyDays)) {
        problems.push(`\`credentials[${i}].everyDays\` must be a number.`);
      }
    },
  );

  if (
    config.warnWithinDays !== undefined &&
    !Number.isFinite(config.warnWithinDays)
  ) {
    problems.push("`warnWithinDays` must be a number.");
  }

  if (
    config.versions !== undefined &&
    !(Array.isArray(config.versions) && config.versions.every(isString))
  ) {
    problems.push("`versions` must be a list of package names.");
  }

  return problems;
}

/** The config with every list present, so callers never test for undefined. */
export function withDefaults(config) {
  return {
    runtimes: [],
    pinned: [],
    unreachable: [],
    credentials: [],
    versions: [],
    warnWithinDays: 180,
    ...config,
  };
}
