# Deep Review

**Ten reviewers, one diff, at the same time — then everything they found gets
put on trial.**

[![CI](https://github.com/DemchaAV/deep-review/actions/workflows/ci.yml/badge.svg)](https://github.com/DemchaAV/deep-review/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-black.svg)](package.json)

One reviewer reading a diff finds what that reviewer is primed to notice. Ten
reviewers with ten different mandates, reading it simultaneously, find close to
the union. The price is a pile of confident false positives — which is what the
second pass exists to destroy.

```
                     ┌─ line-by-line ──┐
  prepare-review     ├─ removed-behav ─┤     collect-findings
  target → run dir ──┼─ cross-file ────┼──→  dedupe → clusters
                     ├─ platform ──────┤            │
                     └─ …six more ─────┘            ▼
                                            verifier agents (parallel)
                                            CONFIRMED / PLAUSIBLE / REJECTED
                                                     │
  one ranked report  ←───────────────────────────────┘
```

No dependencies. No build. Two Node scripts and a pile of carefully written
prompts.

---

## Compatibility

The reviewing logic is client-independent. What differs is only how each agent
is told the capability exists.

| Client | Fan-out | Entry point | Install |
|---|---|---|---|
| **Claude Code** | native — ten `Agent` calls in one message | `/deep-review` | plugin marketplace |
| **Codex CLI** | `run-review.mjs` spawns `codex exec` per angle | `$deep-review` | `install-client.mjs codex` |
| **Google Antigravity** | `run-review.mjs` spawns `gemini` per angle | `/deep-review` | `install-client.mjs antigravity` |
| **Anything else / CI** | same script, `--agent <cli>` | `npm run review` |
| **git pre-push hook** | — asks, never runs | automatic on `git push` | clone and run |

Claude Code gets the richest experience because it has a real parallel-subagent
primitive. Everywhere else, `scripts/run-review.mjs` *is* the fan-out: it writes
one prompt per angle and spawns one headless CLI process for each, with a
concurrency pool. Same angles, same dedupe, same verify pass, same report.

### Claude Code

```bash
claude plugin marketplace add DemchaAV/deep-review
claude plugin install deep-review@deep-review
```

Then `/deep-review`. The ten angles are registered as subagents and run
concurrently inside your session.

### Codex CLI

```bash
git clone https://github.com/DemchaAV/deep-review
node deep-review/scripts/install-client.mjs codex
```

Installs a skill into `~/.codex/skills/deep-review/`. Ask for a deep review, or
invoke `$deep-review`.

### Google Antigravity

```bash
git clone https://github.com/DemchaAV/deep-review
node deep-review/scripts/install-client.mjs antigravity              # global
node deep-review/scripts/install-client.mjs antigravity --workspace . # one project
```

Installs a workflow — globally under `~/.gemini/antigravity/global_workflows/`,
or into a project's `.agents/workflows/`. Invoke it in Agent with
`/deep-review`.

### Before you push

The moment worth catching is after the code is written and before it becomes a
pull request: findings can still be folded into the branch quietly, whereas once
the PR is open every fix is a visible extra commit.

```bash
node deep-review/scripts/install-client.mjs githook --workspace .
```

Installs a `pre-push` hook that checks whether any review has covered the
commits you are about to push, and tells you if none has. **It never runs a
review itself** — a review spawns a dozen model sessions and takes minutes, and
a push must not silently do that. It asks the question and gets out of the way.

| Variable | Effect |
|---|---|
| *(default)* | warns, then pushes |
| `DEEP_REVIEW_REQUIRE=1` | an unreviewed push fails |
| `DEEP_REVIEW_SKIP=1` | silent for this one push |

Reviews are matched by the head commit they covered, not by branch name, so
amending a commit correctly invalidates its review. Installing over a `pre-push`
hook that deep-review did not write is refused unless you pass `--force`.

### Any terminal, or CI

```bash
node deep-review/scripts/run-review.mjs 4821 --agent claude --effort deep
```

`--agent` takes `claude`, `codex` or `gemini`; omit it and the first one found
on `PATH` is used. Nothing about this path requires an IDE.

---

## Use

```bash
/deep-review                            # uncommitted work + commits since the merge-base
/deep-review 4821                       # a GitHub PR (needs gh)
/deep-review branch                     # the current branch vs its merge-base
/deep-review origin/main..HEAD          # any range
/deep-review --effort deep              # all ten angles instead of seven
/deep-review --angles reuse,efficiency  # only those
```

Anything else you type is passed to every angle as a reviewer's note, so
`/deep-review 4821 the caching layer worries me` aims all ten at the caching
layer without narrowing what they are allowed to find.

---

## The angles

| Angle | Owns |
|---|---|
| line-by-line | every hunk and its enclosing function |
| removed-behavior | what the deleted lines used to enforce |
| cross-file | consumers of everything that changed |
| platform | the language's and the OS's classic traps |
| wrapper | wrappers, adapters, proxies, projections |
| conventions | the repo's own `CLAUDE.md` / `AGENTS.md` rules |
| altitude | whether each fix is at the right depth |
| reuse | new code that re-implements an existing helper |
| simplification | complexity the diff adds |
| efficiency | work the diff wastes |

`quick` (4 angles), `standard` (7 angles, the default) and `deep` (10 angles)
select how many run. An angle with nothing to look at is dropped rather than run — the
conventions angle does not run in a repo with no governing docs, because an
angle with no ground returns noise, not silence.

The **platform** angle reads a per-language trap catalogue chosen from what the
diff actually contains: JavaScript, TypeScript, Python, Java/Kotlin, Go, Rust,
shell, or a language-independent fallback. They live in
[`skills/deep-review/references/pitfalls/`](skills/deep-review/references/pitfalls/)
and are worth reading on their own.

---

## Why the verify pass

A finder angle is rewarded for noticing things, so it notices things that are
not there. Ten of them produce up to eighty candidates for one diff, most of
them wrong, many of them the same defect described three ways.

So the candidates are not reported. They are:

1. **Deduplicated** — `collect-findings.mjs` merges candidates that describe one
   defect, using an overlap measure over content words rather than exact text,
   because two angles never phrase it the same way. Corroboration is recorded
   but never treated as evidence.
2. **Put on trial** — verifier agents open the real code and try to *disprove*
   each survivor: is the line even there, is there a guard above it, is the
   claimed input reachable, does a test already cover it. They return
   `CONFIRMED`, `PLAUSIBLE` or `REJECTED` **with the reason**.
3. **Ranked** — correctness ahead of quality, confirmed ahead of plausible.

Only the survivors reach you. **A run where most candidates are rejected is the
system working**, and the tool says so out loud rather than padding the report.

---

## What it writes

Everything lands in `.deep-review/<run-id>/` in the repo under review:

```
context.md      the briefing every agent received
code.diff       docs and lockfiles excluded — what the finders read first
full.diff       the same plus docs and config
prompts/        the exact prompt each angle was given
findings/       one JSON file per angle, as raw as it came back
clusters.json   deduplicated candidates and the verify batches
verdicts/       one file per batch, with the reason for every verdict
logs/           stdout and stderr of every spawned agent
report.json     the ranked survivors
report.md       the same, readable
```

The trail is the point: every finding walks back to the angle that raised it and
the verifier that let it through. `.deep-review/` belongs in your `.gitignore`.

---

## Design

Two halves, deliberately separated.

**The deterministic half** decides everything a script can decide — what is in
scope, what changed, which language, which duplicates are one defect, what
survived, how it ranks. It has no model in it, so it cannot be skipped,
forgotten or hallucinated.

**The model half** does only what needs judgement: reading code and forming an
opinion. Each angle is a self-contained prompt with a narrow mandate and a
concrete hunting list, and the same ten prompts drive every client.

Some consequences worth knowing:

- `git diff` never shows untracked files, so a brand-new file in uncommitted
  work would be invisible to a reviewer — exactly the file most worth reading.
  `prepare-review.mjs` synthesises those patches with `--no-index` rather than
  touching your index. **A review never mutates the repository**, including its
  staging area.
- Agents are given a diff with twelve lines of context, not three, and are told
  to open the enclosing function anyway. A bug in an unchanged line of a touched
  function is in scope; the change is what made it reachable.
- Prompts are passed as file paths relative to the working directory, never as
  long command-line strings. `cmd.exe` cannot be reliably quoted against
  embedded quotes, and the fix is to not need quoting.
- The angle list is restated for several different readers — the runner reads
  JSON, the in-Claude orchestrator reads prose, humans read a table, and each
  client adapter repeats it again. `check-consistency.mjs` discovers those files
  rather than listing them, and fails CI if any disagrees. A review that
  silently runs nine angles while claiming ten is precisely the defect class
  this tool exists to catch, and the gate's own inputs were hard-coded until a
  run of this tool on itself pointed that out.

---

## Development

```bash
npm run verify                        # consistency gate + tests, no API calls
npm test                              # node --test over scripts/test/
node scripts/run-review.mjs --dry-run # writes prompts, spawns nothing
```

No dependencies, and it should stay that way. CI runs Ubuntu and Windows across
Node 20, 22 and 24. See [AGENTS.md](AGENTS.md) for the conventions and the
traps.

### Layout

```
.claude-plugin/plugin.json    Claude Code manifest
commands/deep-review.md       the /deep-review entry point
agents/dr-*.md                ten finder angles + the verifier
skills/deep-review/SKILL.md   the in-Claude orchestration protocol
  references/pitfalls/*.md    per-language trap catalogues
clients/codex/                Codex skill
clients/antigravity/          Antigravity workflow
scripts/prepare-review.mjs    target → run directory
scripts/run-review.mjs        the portable fan-out
scripts/collect-findings.mjs  dedupe, then rank
scripts/check-consistency.mjs the gate that stops the four lists drifting
scripts/run-tests.mjs         portable test discovery, Node 20 and up
```

The angles are **agents**, not skills, because agents are the unit of
parallelism: ten `Agent` calls in one message run concurrently with separate
contexts, while ten skills would load ten sets of instructions into one.

### Adding an angle

Add a `dr-<name>.md` to `agents/` following the shape of the others — a mandate,
a concrete hunting list, and the findings-file JSON contract — then register it
in `scripts/angles.json`, add a row to the table in
`skills/deep-review/SKILL.md`, and add a row to the table above. `npm run check`
fails until they agree, which is the point. Write any effort count as
`` `quick` (4 angles) `` — that exact shape is what the gate can verify.

---

## Licence

MIT — see [LICENSE](LICENSE).
