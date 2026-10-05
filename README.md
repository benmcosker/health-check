# health-check

A weekly health check for npm projects, kept in one GitHub issue.

CI answers "did this commit break anything". Nothing in it answers "did the world
move while nobody was looking": an advisory published against a dependency you
never touched, a package quietly three majors behind, a runtime nearing end of
life, a secret overdue for rotation. This checks those on a calendar instead of
on a commit, and says what it found in one issue that it rewrites each week and
closes itself when there is nothing left to say.

## Add it to a project

From the project's root:

```sh
npx github:benmcosker/health-check init
```

That writes three files and changes nothing else:

| File                                    | What it is                                                              |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `lifecycle.json`                        | What to watch that no package manager knows about. Starts nearly empty. |
| `.github/workflows/health.yml`          | The weekly check. About twenty lines.                                   |
| `.github/workflows/health-watchdog.yml` | Notices when the weekly check did not run.                              |

Then read `lifecycle.json`, commit the three files, and run **Actions → Weekly
health → Run workflow** once to see the first report. It never overwrites a file
that is already there; `--force` is the deliberate version.

To see a report without opening an issue, put `dry-run: "true"` on the action
step. The report goes to the job summary and nothing else is touched.

## What the report covers

- **Advisories** from `npm audit`, split by whether they ship to production. A
  second audit with `--omit=dev` decides that, and `unreachable` in
  `lifecycle.json` records the ones you have checked by hand and found cannot be
  reached from a request. They are still printed; they just stop being counted
  as exposure.
- **Behind**: packages that have fallen one or more majors or minors behind.
  Patches are left out on purpose.
- **Runtimes**: end-of-life dates, fetched from [endoflife.date](https://endoflife.date)
  each week rather than written down, because a copied date is wrong the first
  time upstream moves it.
- **Credentials**: how old each secret is, against how often you said it should
  rotate. It reports a missing date but never opens the issue on its own for one.
- **Schema drift**, if the project has its own check (below).

When the issue opens, closes or stays quiet is deliberate. It opens for any
advisory at moderate or above, any package a major or minor behind, a runtime
ended or ending, an overdue secret, or confirmed drift. It also opens when it
**could not look** - `npm audit` returned nothing, a lookup failed - because
"could not check" and "found nothing" are different answers and only one of them
deserves silence.

## `lifecycle.json`

All keys are optional, and unknown keys are an error: a misspelt key silently
becoming an empty list is how a week looks clean for the wrong reason.

```json
{
  "runtimes": [
    { "product": "nodejs", "cycle": "22", "used": "CI and production" }
  ],
  "credentials": [
    {
      "name": "API_KEY",
      "where": "Provider console → API keys",
      "rotatedOn": "2026-09-19",
      "everyDays": 365,
      "note": "Create the new one before revoking the old."
    }
  ],
  "unreachable": [
    {
      "package": "prisma",
      "why": "A CLI. Never imported at runtime.",
      "checkedOn": "2026-09-19"
    }
  ],
  "pinned": [
    {
      "package": "@types/node",
      "track": "22",
      "why": "Types describe the runtime, not the registry.",
      "checkedOn": "2026-09-19"
    }
  ],
  "versions": ["next", "prisma"],
  "warnWithinDays": 180
}
```

| Key              | Meaning                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtimes`       | `product` and `cycle` as endoflife.date spells them. `cycle` is a string: `"22"`, not `22`.                                                                          |
| `credentials`    | Secrets you rotate by hand. `rotatedOn: null` means nobody has written the date down yet.                                                                            |
| `unreachable`    | Advisories checked by hand to be unreachable from a request. Give each a reason and a date.                                                                          |
| `pinned`         | Packages deliberately held to a release line, measured against that line and not against `latest`. A pinned package that falls behind inside its line still reports. |
| `versions`       | Packages whose declared version should be listed at the bottom of the report.                                                                                        |
| `warnWithinDays` | How far ahead an approaching end of life is flagged. Default 180.                                                                                                    |

Extra fields inside an entry are fine; that is where the notes that explain
themselves go.

## The action

```yaml
- uses: benmcosker/health-check@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

Run it **after** `npm ci`. It refuses to run without `node_modules`, because
`npm outdated` with nothing installed has nothing to compare and reports every
package as current - a clean report built on not looking.

| Input                 | Default                     |                                                        |
| --------------------- | --------------------------- | ------------------------------------------------------ |
| `github-token`        | required                    | Needs `issues: write`.                                 |
| `lifecycle-file`      | `lifecycle.json` if present | A path that is given and missing is an error.          |
| `issue-title`         | `Weekly health`             | Matched by exact title; changing it opens a new issue. |
| `issue-label`         | `health`                    |                                                        |
| `drift`, `drift-note` | none                        | See below.                                             |
| `working-directory`   | `.`                         | For a project that is not at the repository root.      |
| `dry-run`             | `false`                     | Report to the job summary, touch no issues.            |

Outputs: `needed` (`"true"` or `"false"`) and `body` (the Markdown).

The job needs `permissions: { contents: read, issues: write }` and nothing more.

### Schema drift

Left out unless you ask for it, because what it means depends on the project.
Run your own check first and tell the action what it found. For Prisma:

```yaml
- name: Check for schema drift
  id: drift
  run: |
    npm run db:deploy
    npx prisma migrate diff --from-config-datasource \
      --to-schema prisma/schema.prisma --exit-code > /tmp/drift.txt 2>&1 \
      && drift=false || drift=true
    echo "drift=$drift" >> "$GITHUB_OUTPUT"

- uses: benmcosker/health-check@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    drift: ${{ steps.drift.outputs.drift }}
    drift-note: "`prisma/schema.prisma` and the migrations disagree. A migration is missing."
```

Leave `drift` unset and the report has no Schema section at all, rather than a
reassuring one about a check that never ran.

## The watchdog

A scheduled workflow GitHub drops leaves no run, no annotation and no red tick,
so the weekly check cannot report its own absence. The watchdog runs daily,
asks the Actions API when the weekly check last **succeeded**, and files an issue
if that was more than eight days ago. It needs no checkout, no install and no
packages, so nothing the weekly check depends on can break it.

```yaml
- uses: benmcosker/health-check/watchdog@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    workflow: health.yml
```

Needs `permissions: { actions: read, issues: write }`. A run you start by hand
counts as a success, because what matters is that a report arrived.

## Limits

- **Schedules are best effort.** GitHub runs every repository's scheduled
  workflows off one queue and drops what it cannot reach, and in practice they
  start hours late. A weekly report can wait; a missed one cannot go unnoticed,
  which is what the watchdog is for. But the watchdog runs on the same
  scheduler as the thing it watches, so it makes a miss unlikely to go
  unnoticed, not impossible. A real dead man's switch lives off GitHub.
- **npm only.** Other ecosystems would be separate adapters, added when a real
  project needs one.
- **It needs `npm ci` first,** and says so loudly if it was skipped.
- **Runtime dates come from endoflife.date.** If it does not answer, the report
  says it could not look rather than saying the runtime is fine.

## Versions

Pin a major: `@v1`. It moves for fixes and additions and will not change what an
existing config means. A breaking change is a new major.

## Development

```sh
npm ci
npm test
```

| Path                         |                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `action.yml`                 | The weekly check, as a composite action.                                             |
| `watchdog/action.yml`        | The watchdog.                                                                        |
| `src/health-report.mjs`      | The judgement calls: what counts as attention, what the report says. Pure functions. |
| `src/health-check.mjs`       | The entry point. Reads the project, writes the report.                               |
| `src/config.mjs`             | Validates `lifecycle.json`.                                                          |
| `src/watchdog-*.mjs`         | The watchdog's logic and entry point.                                                |
| `bin/init.mjs`, `templates/` | The bootstrap.                                                                       |

No runtime dependencies, on purpose: the action runs in other people's
workflows, straight after their own install, and should not be something that
can break one.

`action.yml` is YAML that only GitHub can run, so CI runs it on every push
against this repository in dry-run mode, and this repository checks itself with
it every week.

## License

[MIT](LICENSE).
