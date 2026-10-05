import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  SOURCE,
  REF,
  detectFrameworks,
  detectNode,
  init,
  pickMinutes,
  render,
} from "../bin/init.mjs";
import { validateConfig } from "../src/config.mjs";

const dirs: string[] = [];

function project(
  files: Record<string, string> = {},
  pkg: object = { name: "demo" },
) {
  const dir = mkdtempSync(join(tmpdir(), "health-init-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("init", () => {
  it("writes the three files, and the workflows are valid YAML that call this repo", () => {
    const dir = project({}, { name: "demo", engines: { node: ">=20.11" } });
    const r = init({ dir });

    expect(r.written).toHaveLength(3);
    const weekly = parse(
      readFileSync(join(dir, ".github/workflows/health.yml"), "utf8"),
    );
    const watchdog = parse(
      readFileSync(join(dir, ".github/workflows/health-watchdog.yml"), "utf8"),
    );

    const steps = weekly.jobs.health.steps;
    expect(steps.at(-1).uses).toBe(`${SOURCE}@${REF}`);
    expect(steps.some((s: { run?: string }) => s.run === "npm ci")).toBe(true);
    expect(weekly.permissions).toEqual({ contents: "read", issues: "write" });
    expect(watchdog.jobs.watchdog.steps[0].uses).toBe(
      `${SOURCE}/watchdog@${REF}`,
    );
    expect(watchdog.permissions).toEqual({ actions: "read", issues: "write" });
  });

  it("leaves no placeholder behind, and keeps GitHub's own expressions", () => {
    const dir = project();
    init({ dir });
    for (const f of [
      ".github/workflows/health.yml",
      ".github/workflows/health-watchdog.yml",
    ]) {
      const text = readFileSync(join(dir, f), "utf8");
      // Ours are {{UPPER_CASE}}. `${{ secrets.GITHUB_TOKEN }}` is GitHub's,
      // has to survive rendering, and must not be mistaken for a leftover.
      expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/);
      expect(text).toContain("${{ secrets.GITHUB_TOKEN }}");
    }
  });

  it("writes a lifecycle.json that passes its own validation", () => {
    const dir = project(
      {},
      { name: "demo", dependencies: { next: "^16", react: "^19" } },
    );
    init({ dir });
    const config = JSON.parse(
      readFileSync(join(dir, "lifecycle.json"), "utf8"),
    );
    expect(validateConfig(config)).toEqual([]);
    expect(config.versions).toEqual(["next", "react"]);
    expect(config.runtimes[0]).toMatchObject({
      product: "nodejs",
      cycle: expect.any(String),
    });
  });

  it("never overwrites what is already there", () => {
    const dir = project({ "lifecycle.json": '{"edited": "marker-9f3c"}' });
    const r = init({ dir });
    expect(r.skipped).toHaveLength(1);
    expect(readFileSync(join(dir, "lifecycle.json"), "utf8")).toBe(
      '{"edited": "marker-9f3c"}',
    );
    // The other two did not exist, so they are written.
    expect(r.written).toHaveLength(2);
  });

  it("overwrites only when told to", () => {
    const dir = project({ "lifecycle.json": '{"edited": "marker-9f3c"}' });
    init({ dir, force: true });
    expect(readFileSync(join(dir, "lifecycle.json"), "utf8")).not.toContain(
      "marker-9f3c",
    );
  });

  it("refuses a directory that is not an npm project", () => {
    const dir = mkdtempSync(join(tmpdir(), "health-init-"));
    dirs.push(dir);
    expect(() => init({ dir })).toThrow("No package.json");
    expect(existsSync(join(dir, ".github"))).toBe(false);
  });

  it("points at a real owner/repo, so these workflows can resolve", () => {
    expect(SOURCE).toMatch(/^[\w.-]+\/[\w.-]+$/);
    expect(REF).toMatch(/^v\d+$/);
  });
});

describe("detectNode", () => {
  it("prefers .nvmrc, then .node-version, then package.json", () => {
    expect(
      detectNode(
        project({ ".nvmrc": "v20.11.0\n" }, { engines: { node: "22" } }),
      ),
    ).toEqual({
      major: "20",
      from: ".nvmrc",
    });
    expect(detectNode(project({ ".node-version": "18" })).major).toBe("18");
    expect(detectNode(project({}, { engines: { node: ">=22.0.0" } }))).toEqual({
      major: "22",
      from: "package.json engines",
    });
    expect(detectNode(project({}, { volta: { node: "20.1.0" } })).from).toBe(
      "package.json volta",
    );
  });

  it("says so when it had to guess", () => {
    expect(detectNode(project()).from).toContain("assumed");
  });
});

describe("detectFrameworks", () => {
  it("lists the known ones found in either kind of dependency", () => {
    expect(
      detectFrameworks({
        dependencies: { next: "1", lodash: "1" },
        devDependencies: { typescript: "5" },
      }),
    ).toEqual(["next", "typescript"]);
    expect(detectFrameworks({})).toEqual([]);
  });
});

describe("pickMinutes", () => {
  it("never lands on a round minute, where everybody else's cron is", () => {
    for (const seed of ["a", "demo", "trivet", "x".repeat(40), "☃", ""]) {
      const { weekly, daily } = pickMinutes(seed);
      for (const m of [weekly, daily]) {
        expect(m % 15).not.toBe(0);
        expect(m).toBeGreaterThanOrEqual(3);
        expect(m).toBeLessThan(60);
      }
    }
  });

  it("gives the same answer twice, so re-running init does not churn the file", () => {
    expect(pickMinutes("demo")).toEqual(pickMinutes("demo"));
  });
});

describe("render", () => {
  it("replaces every occurrence", () => {
    expect(render("{{A}} {{A}} {{B}}", { A: 1, B: "x" })).toBe("1 1 x");
  });
});

describe("the command line", () => {
  const BIN = join(import.meta.dirname, "..", "bin", "init.mjs");
  const cli = (args: string[], cwd?: string) =>
    spawnSync("node", [BIN, ...args], { encoding: "utf8", cwd });

  // The unit tests above call init() directly, which is how a bug in argument
  // parsing - `--dir /path` read as the command - got past all of them.
  it("takes a directory after --dir", () => {
    const dir = project();
    const r = cli(["--dir", dir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("wrote    lifecycle.json");
    expect(existsSync(join(dir, ".github/workflows/health.yml"))).toBe(true);
  });

  it("works from the project's own directory with no arguments", () => {
    const dir = project();
    expect(cli([], dir).status).toBe(0);
    expect(existsSync(join(dir, "lifecycle.json"))).toBe(true);
  });

  it("reports what it skipped on the second run", () => {
    const dir = project();
    cli(["--dir", dir]);
    const again = cli(["--dir", dir]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("skipped  lifecycle.json");
  });

  it("fails clearly outside an npm project", () => {
    const dir = mkdtempSync(join(tmpdir(), "health-init-"));
    dirs.push(dir);
    const r = cli(["--dir", dir]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("No package.json");
  });

  it("rejects a command it does not know", () => {
    expect(cli(["frobnicate"]).status).toBe(2);
  });
});
