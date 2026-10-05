import { describe, expect, it } from "vitest";

import { validateConfig, withDefaults } from "../src/config.mjs";

describe("validateConfig", () => {
  it("accepts the shape a real project uses, extra notes and all", () => {
    expect(
      validateConfig({
        $comment: ["what this file is"],
        runtimes: [{ product: "nodejs", cycle: "22", used: "CI" }],
        pinned: [
          { package: "@types/node", track: "22", why: "tracks runtime" },
        ],
        unreachable: [
          { package: "prisma", why: "a CLI", checkedOn: "2026-09-19" },
        ],
        credentials: [
          // `dueMonth` is a note for people; nothing reads it, and a check
          // that rejects a comment teaches people to stop writing them.
          {
            name: "API_KEY",
            rotatedOn: "2026-09-19",
            everyDays: 365,
            dueMonth: "September",
          },
        ],
        versions: ["next"],
        warnWithinDays: 180,
      }),
    ).toEqual([]);
  });

  it("accepts an empty file, because a new project has nothing to say yet", () => {
    expect(validateConfig({})).toEqual([]);
  });

  it("treats a null rotation date as 'not recorded', not as an error", () => {
    // Found by running a real project's config through this: `null` is the
    // documented way to say a secret has no date yet.
    expect(
      validateConfig({ credentials: [{ name: "TOKEN", rotatedOn: null }] }),
    ).toEqual([]);
  });

  it("refuses an unknown top-level key, which is how a typo becomes an empty list", () => {
    const problems = validateConfig({ unreachble: [{ package: "x" }] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Unknown key `unreachble`");
    expect(problems[0]).toContain("unreachable");
  });

  it("names the entry that is missing a required field", () => {
    const problems = validateConfig({
      pinned: [{ package: "@types/node" }],
      credentials: [{ where: "somewhere" }],
    });
    expect(problems).toContain("`pinned[0]` needs a `track` (on @types/node).");
    expect(
      problems.some((p) => p.includes("`credentials[0]` needs a `name`")),
    ).toBe(true);
  });

  it("insists a runtime cycle is a string, because 22 is not '22' in a URL", () => {
    const problems = validateConfig({
      runtimes: [{ product: "nodejs", cycle: 22 }],
    });
    expect(problems.join("\n")).toContain('must be a string like "22"');
  });

  it("rejects a rotation date that is not a date", () => {
    const problems = validateConfig({
      credentials: [{ name: "T", rotatedOn: "last tuesday" }],
    });
    expect(problems[0]).toContain("is not a date");
  });

  it("rejects things that are not the right kind of thing", () => {
    expect(validateConfig([])).toEqual([
      "The file must contain a JSON object.",
    ]);
    expect(validateConfig({ runtimes: "nodejs 22" })).toEqual([
      "`runtimes` must be a list.",
    ]);
    expect(validateConfig({ versions: [1, 2] })[0]).toContain(
      "list of package names",
    );
    expect(validateConfig({ warnWithinDays: "soon" })[0]).toContain(
      "must be a number",
    );
  });
});

describe("withDefaults", () => {
  it("gives every list, so callers never test for undefined", () => {
    const c = withDefaults({});
    expect(c).toMatchObject({
      runtimes: [],
      pinned: [],
      unreachable: [],
      credentials: [],
      versions: [],
      warnWithinDays: 180,
    });
  });

  it("keeps what the project said", () => {
    expect(withDefaults({ warnWithinDays: 90 }).warnWithinDays).toBe(90);
  });
});
