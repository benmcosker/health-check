#!/usr/bin/env node
/**
 * Set a project up for the weekly health check.
 *
 *   npx github:benmcosker/health-check init            # in the project's root
 *   npx github:benmcosker/health-check init --force    # overwrite what is already there
 *
 * Writes three files and changes nothing else:
 *
 *   lifecycle.json                       what to watch beyond packages
 *   .github/workflows/health.yml         the weekly check
 *   .github/workflows/health-watchdog.yml  notices when it did not run
 *
 * It never overwrites a file that is already there, because by the second
 * time somebody runs this they have edited those files. `--force` is the
 * deliberate version.
 *
 * No dependencies: it is fetched by `npx` straight from the repository.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repository these files point at, and the version they pin.
export const SOURCE = "benmcosker/health-check";
export const REF = "v1";

const here = dirname(fileURLToPath(import.meta.url));
const template = (name) =>
  readFileSync(join(here, "..", "templates", name), "utf8");

/** Frameworks worth listing under `versions` when the project uses them. */
const FRAMEWORKS = [
  "next",
  "nuxt",
  "react",
  "vue",
  "svelte",
  "@sveltejs/kit",
  "astro",
  "express",
  "fastify",
  "@nestjs/core",
  "prisma",
  "typescript",
];

/** The major Node version a project says it wants, and where that came from. */
export function detectNode(dir) {
  const read = (f) => {
    try {
      return readFileSync(join(dir, f), "utf8").trim();
    } catch {
      return null;
    }
  };
  const major = (text) => /(\d{2})/.exec(String(text ?? ""))?.[1] ?? null;

  for (const file of [".nvmrc", ".node-version"]) {
    const found = major(read(file));
    if (found) return { major: found, from: file };
  }
  let pkg = {};
  try {
    pkg = JSON.parse(read("package.json") ?? "{}");
  } catch {
    // Reported by whoever reads package.json next; not this function's job.
  }
  const fromEngines = major(pkg.engines?.node);
  if (fromEngines) return { major: fromEngines, from: "package.json engines" };
  const fromVolta = major(pkg.volta?.node);
  if (fromVolta) return { major: fromVolta, from: "package.json volta" };

  return { major: "22", from: "nothing found - assumed" };
}

/** Which of the known frameworks this project depends on. */
export function detectFrameworks(pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return FRAMEWORKS.filter((name) => name in deps);
}

/**
 * A minute that is not on the hour or the half.
 *
 * Random on purpose, not cosmetic: scheduled workflows share one queue, and the
 * round numbers are where everybody else's are. Seeded from the directory name
 * so running this twice in the same project gives the same answer.
 */
export function pickMinutes(seed) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const ok = [...Array(55).keys()]
    .map((n) => n + 3)
    .filter((n) => n % 15 !== 0);
  const first = ok[h % ok.length];
  const second = ok[(h >>> 8) % ok.length];
  return { weekly: first, daily: second };
}

export function render(text, values) {
  return Object.entries(values).reduce(
    (out, [k, v]) => out.replaceAll(`{{${k}}}`, String(v)),
    text,
  );
}

function write(path, content, { force, written, skipped }) {
  if (existsSync(path) && !force) {
    skipped.push(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  written.push(path);
}

export function init({ dir, force = false }) {
  const root = resolve(dir);
  if (!existsSync(join(root, "package.json"))) {
    throw new Error(
      `No package.json in ${root}. Run this from the root of an npm project.`,
    );
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const node = detectNode(root);
  const frameworks = detectFrameworks(pkg);
  const minutes = pickMinutes(pkg.name ?? root);

  const lifecycle = JSON.parse(template("lifecycle.json"));
  lifecycle.runtimes = [
    {
      product: "nodejs",
      cycle: node.major,
      used: `CI and runtime (${node.from})`,
    },
  ];
  lifecycle.versions = frameworks;

  const values = {
    CRON: `${minutes.weekly} 7 * * 1`,
    WATCHDOG_CRON: `${minutes.daily} 8 * * *`,
    NODE: node.major,
    SOURCE,
    REF,
  };

  const state = { force, written: [], skipped: [] };
  write(
    join(root, "lifecycle.json"),
    `${JSON.stringify(lifecycle, null, 2)}\n`,
    state,
  );
  write(
    join(root, ".github/workflows/health.yml"),
    render(template("health.yml"), values),
    state,
  );
  write(
    join(root, ".github/workflows/health-watchdog.yml"),
    render(template("health-watchdog.yml"), values),
    state,
  );

  return { ...state, node, frameworks, minutes, root };
}

// Run directly, not imported by a test.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  // The value after --dir is an argument, not the command.
  const command =
    args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--dir") ??
    "init";
  if (command !== "init" || args.includes("--help")) {
    console.log("Usage: init [--force] [--dir <path>]");
    process.exit(command === "init" ? 0 : 2);
  }
  const dirFlag = args.indexOf("--dir");
  try {
    const result = init({
      dir: dirFlag >= 0 ? args[dirFlag + 1] : process.cwd(),
      force: args.includes("--force"),
    });
    for (const f of result.written)
      console.log(`  wrote    ${f.replace(`${result.root}/`, "")}`);
    for (const f of result.skipped) {
      console.log(
        `  skipped  ${f.replace(`${result.root}/`, "")} (already there; --force to replace)`,
      );
    }
    console.log(
      `\nNode ${result.node.major} (${result.node.from}). ` +
        `Frameworks listed: ${result.frameworks.join(", ") || "none"}.\n` +
        "\nNext:\n" +
        "  1. Read lifecycle.json and add the secrets you rotate and the runtimes you depend on.\n" +
        "  2. Commit all three files and push.\n" +
        "  3. Actions -> Weekly health -> Run workflow, once, to see the first report.\n" +
        '     (Try it first without opening an issue: set `dry-run: "true"` on the step.)',
    );
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
