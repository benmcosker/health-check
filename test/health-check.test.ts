import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/*
 * The entry point run for real, in a throwaway project. These cover what the
 * unit tests cannot: the setup mistakes that must stop the run instead of
 * producing a report, because a report is what people believe.
 */

const ENTRY = join(import.meta.dirname, "..", "src", "health-check.mjs");
const dirs: string[] = [];

/** A project directory, with whatever the test wants in it. */
function project(
  files: Record<string, unknown> = {},
  { installed = true, withPackage = true } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "health-check-"));
  dirs.push(dir);
  if (withPackage) {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "fixture", dependencies: { next: "^16.0.0" } }),
    );
  }
  if (installed) mkdirSync(join(dir, "node_modules"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(
      join(dir, name),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return dir;
}

function run(dir: string, env: Record<string, string> = {}) {
  const out = join(dir, "github-output.txt");
  writeFileSync(out, "");
  const result = spawnSync("node", [ENTRY], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: out, ...env },
  });
  return { ...result, output: readFileSync(out, "utf8") };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const clean = { vulnerabilities: {}, metadata: { vulnerabilities: {} } };

describe("health-check entry point", () => {
  it("refuses to run with no node_modules, which would read as 'nothing is behind'", () => {
    // `npm outdated` with nothing installed has nothing to compare, so every
    // package looks current. That is a clean report built on not looking.
    const dir = project({}, { installed: false });
    const r = run(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("No node_modules");
    expect(r.stderr).toContain("npm ci");
    expect(r.output).toBe("");
  });

  it("refuses a directory that is not an npm project", () => {
    const r = run(project({}, { withPackage: false }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("No package.json");
  });

  it("stops on a config with a typo instead of ignoring it", () => {
    const dir = project({ "lifecycle.json": { unreachble: [] } });
    const r = run(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Unknown key `unreachble`");
    expect(r.output).toBe("");
  });

  it("stops when a config that was asked for is not there", () => {
    const r = run(project(), { HEALTH_LIFECYCLE: "nope.json" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("does not exist");
  });

  it("runs with no config at all, because a new project has none yet", () => {
    const dir = project({ "audit.json": clean, "prod.json": clean });
    const r = run(dir, {
      HEALTH_AUDIT: join(dir, "audit.json"),
      HEALTH_AUDIT_PROD: join(dir, "prod.json"),
      HEALTH_OUTDATED: join(dir, "missing-because-nothing-is-outdated.json"),
    });
    expect(r.status).toBe(0);
    expect(r.output).toContain("needed=false");
  });

  it("files a report when an advisory ships to production", () => {
    const vuln = {
      vulnerabilities: {
        leftpad: { severity: "critical", isDirect: true, fixAvailable: true },
      },
      metadata: { vulnerabilities: { critical: 1 } },
    };
    const dir = project({ "audit.json": vuln, "prod.json": vuln });
    const r = run(dir, {
      HEALTH_AUDIT: join(dir, "audit.json"),
      HEALTH_AUDIT_PROD: join(dir, "prod.json"),
    });
    expect(r.status).toBe(0);
    expect(r.output).toContain("needed=true");
    expect(r.output).toContain(
      "**leftpad** - critical, direct dependency, ships to production",
    );
  });

  it("opens the issue when the audit produced nothing, instead of calling the week clear", () => {
    // The default for an unset path is /dev/null, which parses as empty.
    // Empty is 'could not check', and that must keep the issue open.
    const r = run(project());
    expect(r.status).toBe(0);
    expect(r.output).toContain("needed=true");
    expect(r.output).toContain("Could not check.");
  });

  it("reports the versions the project said it cares about, from its own package.json", () => {
    const dir = project({
      "lifecycle.json": { versions: ["next", "not-installed"] },
    });
    const r = run(dir);
    expect(r.output).toContain("- next: ^16.0.0");
    expect(r.output).toContain("- not-installed: unknown");
  });

  it("leaves the Schema section out unless the project checks for drift", () => {
    const dir = project();
    expect(run(dir).output).not.toContain("## Schema");
    expect(run(dir, { DRIFT: "false" }).output).toContain("## Schema");
  });
});
