# Changelog

All notable changes to this project are documented here. Versions follow
[semantic versioning](https://semver.org/); while the major version is 0 the
contracts below may still move.

## [0.1.0] — 2026-09-02

First public release.

### Added

- **Ten finder angles**, each a self-contained agent definition with a narrow
  mandate and a concrete hunting list: line-by-line, removed-behavior,
  cross-file, platform, wrapper, conventions, altitude, reuse, simplification,
  efficiency. Effort presets select four, seven or all ten.
- **An adversarial verify pass.** Candidates are never reported directly.
  Duplicates are merged across angles on an overlap measure over content words,
  then verifier agents open the real code and try to *disprove* each survivor,
  returning `CONFIRMED`, `PLAUSIBLE` or `REJECTED` with a reason. Only the first
  two reach the user.
- **`prepare-review.mjs`** — resolves a target (working tree, branch, ref,
  range, or a GitHub PR), computes the merge base, splits code from docs,
  detects the language, and finds every `CLAUDE.md` and `AGENTS.md` above a
  changed file. Untracked files are synthesised with `--no-index` rather than by
  touching the index: a review never mutates the repository, staging area
  included.
- **`collect-findings.mjs`** — deduplicates across angles, batches the survivors
  for verification, then ranks what survived.
- **`run-review.mjs`** — the portable fan-out. Inside Claude Code the ten angles
  are native parallel subagents; everywhere else this spawns one headless CLI
  process per angle through a concurrency pool. Same angles, same dedupe, same
  verify pass, same report.
- **Clients**: a Claude Code plugin, a Codex skill, an Antigravity workflow, and
  a git `pre-push` hook that asks whether a completed review covers the commits
  being pushed. `install-client.mjs` puts each where its client looks for it.
- **Per-language pitfall catalogues** for JavaScript, TypeScript, Python,
  Java/Kotlin, Go, Rust and shell, plus a language-independent fallback. The
  platform angle reads the one the diff actually calls for.
- **`check-consistency.mjs`** — the angle list is restated for several readers
  (the runner reads JSON, the orchestrator reads prose, humans read a table,
  each client adapter repeats it). This gate discovers those files rather than
  listing them and fails CI when any disagrees.
- 43 tests over the deterministic half, on Ubuntu and Windows across Node 20,
  22 and 24.

### Verified

The tool was run against its own diff twice, at 42 files and roughly 4,700 then
5,100 changed lines.

- **First run**: 7 angles, 38 candidates, 34 clusters, 29 confirmed, 3 rejected.
  All 29 were fixed.
- **Second run**: 7 angles, 37 candidates, 33 clusters, 28 confirmed, 2
  rejected. Every defect fixed after the first run stayed fixed; roughly a third
  of the new findings had been *introduced by the fixes themselves*, which is
  the more useful result — repairing what a review finds is a change, and needs
  its own review. All 28 were fixed.

Two findings were checked against `git` rather than taken on trust, and both
held: `**/dist/**` does not exclude a repository-root `dist/`, and
`git diff --numstat` prints a rename as a single unopenable pseudo-path.

### Known limitations

- **The plugin install path has not been exercised.** Every run so far invoked
  `scripts/run-review.mjs` directly. `claude plugin marketplace add` followed by
  `/deep-review` is untested.
- **The Codex and Antigravity adapters have not been run live.** Their formats
  were checked against a real Codex skill on disk and against Antigravity's
  documentation, and their commands are exercised by dry runs, but no full
  review has gone through either.
- **The tool has only ever reviewed itself** — a codebase written quickly over a
  single day. Rejection rates of 9% and 6% across two runs say nothing yet about
  its false-positive rate on mature code.
- Deduplication leaves some residual duplicates: one defect reported at two
  different lines in one file may arrive twice. The similarity threshold has not
  been tuned, because tuning it on a single sample risks merging distinct
  defects, which is the worse failure.
- The consistency gate checks effort *counts* written in prose but not preset
  *membership*, which `SKILL.md` states in prose a gate cannot parse.

[0.1.0]: https://github.com/DemchaAV/deep-review/releases/tag/v0.1.0
