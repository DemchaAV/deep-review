# Working on deep-review

Instructions for coding agents editing this repository. (To *use* deep-review
on your own project, see the README instead.)

## What this is

A review harness with two halves. The deterministic half — `scripts/` — decides
everything a script can decide: what is in scope, what changed, which language,
which duplicates are the same defect, which findings survived. The model half —
`agents/` — does only what needs judgement: reading code and forming an opinion
about it.

**When a change could go in either half, put it in the script half.** A rule a
script enforces cannot be skipped, forgotten, or hallucinated. That is the
design principle this repo is built on, and the `altitude` angle exists to
catch violations of it.

## Verify

```bash
npm run verify
```

That is `check-consistency.mjs` followed by the test suite. Both must pass
before a commit. Node 20 or newer; no dependencies, and it should stay that way.

```bash
npm test                      # scripts/run-tests.mjs over scripts/test/
npm run check                 # the angle-list consistency gate alone
node scripts/run-review.mjs branch --dry-run   # writes prompts, spawns nothing
```

`--dry-run` is how you exercise the orchestrator without spending money. Use it.

## The angle list is restated in several places, and the gate proves they agree

`scripts/angles.json` is the source of truth. The same set is spelled out again
in `agents/` (the definitions), in `skills/deep-review/SKILL.md` (the in-Claude
orchestrator, which reads prose and cannot read JSON), in the README table (for
humans). Each client adapter under `clients/` restates the effort counts but
delegates the angle set itself to the runner, so it is the counts that need
watching there, not a list.

`check-consistency.mjs` **discovers** the prose files rather than listing them,
so a new adapter is covered the day it is added. Its inputs were hard-coded
once, and the two client adapters slipped in with their own stale copies of the
effort counts while the gate reported success. Do not reintroduce a fixed list.

Two rules follow. **Add an angle everywhere in the same commit** — the gate
stops you otherwise. And **write an effort count as `` `quick` (4 angles) ``**:
that is the one shape the gate can check, and a count written any other way is
not protected.

## Conventions

- ESM `.mjs`, no dependencies, no build step. Windows and Linux both matter:
  this is developed on Windows and CI runs both.
- Comments explain *why*, at length where the reason is not obvious from the
  code. Density is deliberate; do not strip it.
- Every script sets `process.exitCode` rather than calling `process.exit()`, so
  pending writes are not truncated.
- An argument flag whose value is missing must refuse, never swallow the next
  argument. There is a test for this.
- Agent definitions must name their findings or verdicts file and must forbid
  committing. There is a test for this too.

## Things that will bite you

- **Windows shell quoting.** `cmd.exe` does not understand `\"` as an escaped
  quote, so one embedded quote flips quote parity for the rest of the line.
  `run-review.mjs` sidesteps this by keeping metacharacters out of arguments
  entirely — prompt paths are relative to the working directory — and asserts
  that invariant rather than trying to quote its way out. Do not "simplify" that
  back into absolute paths.
- **`git diff` never shows untracked files.** `prepare-review.mjs` synthesises
  their patches with `--no-index` rather than touching the index, because a
  review must not mutate the user's staging area.
- **A finding is not the same as a defect.** Finder angles are optimistic by
  construction. Anything that weakens the verify pass — larger batches, weaker
  prompts, promoting rejected findings — makes the whole tool less useful, not
  more thorough.

## Not automatic

Do not commit, push, or open a PR unless asked. Do not run a real (non-dry)
review to "check it works" without asking — it spawns up to sixteen model
sessions and costs real money.
