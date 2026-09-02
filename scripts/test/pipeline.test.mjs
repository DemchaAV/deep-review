// End-to-end tests for the deterministic half of a deep review.
//
// The agents cannot be tested without spending money, but everything around
// them can, and it is the part that silently drops findings when it breaks:
// deduplication that over-merges hides real defects, deduplication that
// under-merges buries the report in duplicates, and a verdict join that loses a
// cluster reports a rejected finding as unverified.
//
//   node --test scripts/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(HERE, "..");
const ROOT = path.resolve(SCRIPTS, "..");

function run(script, args, cwd) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: "utf8", cwd });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

// A repository of our own, with one commit and one uncommitted file. Tests that
// ran against this checkout passed locally and failed in CI for the dullest
// reason: the working tree here is dirty and the one on a runner is clean, so
// "review the working tree" had nothing to review. A test must carry its own
// world.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-review-repo-"));
  const git = (...args) => {
    const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  };
  git("init", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Deep Review Tests");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "committed.mjs"), "export const already = 1;\n", "utf8");
  git("add", "committed.mjs");
  git("commit", "-m", "the state under review");
  // Untracked, so the diff is non-empty whatever the outer checkout looks like.
  fs.writeFileSync(path.join(dir, "pending.mjs"), "export const underReview = 2;\n", "utf8");
  return dir;
}

function makeRun(findingsByAngle) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-review-test-"));
  fs.mkdirSync(path.join(dir, "findings"), { recursive: true });
  fs.mkdirSync(path.join(dir, "verdicts"), { recursive: true });
  for (const [angle, candidates] of Object.entries(findingsByAngle)) {
    fs.writeFileSync(
      path.join(dir, "findings", `${angle}.json`),
      JSON.stringify({ angle, candidates }),
      "utf8"
    );
  }
  return dir;
}

function clusters(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "clusters.json"), "utf8"));
}

// --------------------------------------------------------------- clustering

test("collapses the same defect reported by two angles in different words", () => {
  const dir = makeRun({
    "line-by-line": [
      {
        file: "src/a.mjs",
        line: 42,
        category: "correctness",
        summary: "validatorFor returns undefined errors when the schema fails to compile",
        failure_scenario: "compile throws, the caller reads .errors of undefined",
        confidence: "high",
      },
    ],
    "cross-file": [
      {
        file: "src/a.mjs",
        line: 44,
        category: "cross-file-break",
        summary: "callers still read validate.errors as an array but validatorFor now returns undefined errors",
        failure_scenario: "the consumer crashes on .errors.map",
        confidence: "high",
      },
    ],
  });

  const res = run("collect-findings.mjs", ["collect", dir]);
  assert.equal(res.status, 0, res.stderr);

  const { clusters: list, stats } = clusters(dir);
  assert.equal(list.length, 1, "the two descriptions are one defect");
  assert.equal(stats.collapsed, 1);
  assert.deepEqual(list[0].angles, ["cross-file", "line-by-line"]);
  assert.equal(list[0].corroboration, 2);
});

test("keeps two unrelated defects on adjacent lines of one file apart", () => {
  const dir = makeRun({
    "line-by-line": [
      {
        file: "src/a.mjs",
        line: 42,
        category: "correctness",
        summary: "validatorFor returns undefined errors when the schema fails to compile",
        failure_scenario: "compile throws, the caller reads .errors of undefined",
        confidence: "high",
      },
      {
        file: "src/a.mjs",
        line: 41,
        category: "correctness",
        summary: "the regex metacharacter in the filename is unescaped so only the first dot is replaced",
        failure_scenario: "a file named a.b.mjs matches the wrong pattern",
        confidence: "medium",
      },
    ],
  });

  run("collect-findings.mjs", ["collect", dir]);
  assert.equal(clusters(dir).clusters.length, 2, "adjacent lines are not the same defect");
});

test("keeps a quality finding apart from a correctness finding on the same line", () => {
  const dir = makeRun({
    "line-by-line": [
      {
        file: "src/a.mjs",
        line: 10,
        category: "correctness",
        summary: "the output block dereferences a null report",
        failure_scenario: "report is null when no findings exist",
        confidence: "high",
      },
    ],
    simplification: [
      {
        file: "src/a.mjs",
        line: 10,
        category: "simplification",
        summary: "the output block is duplicated for the json and text modes",
        failure_scenario: "the two renderers drift",
        confidence: "medium",
      },
    ],
  });

  run("collect-findings.mjs", ["collect", dir]);
  const list = clusters(dir).clusters;
  assert.equal(list.length, 2);
  assert.deepEqual(new Set(list.map((c) => c.family)), new Set(["correctness", "quality"]));
});

test("ranks correctness clusters ahead of quality ones", () => {
  const dir = makeRun({
    reuse: [
      {
        file: "src/z.mjs",
        line: 1,
        category: "reuse",
        summary: "reimplements compareVersions from lib/semver.mjs",
        failure_scenario: "two comparators disagree on 2.10",
        confidence: "high",
      },
    ],
    "line-by-line": [
      {
        file: "src/a.mjs",
        line: 1,
        category: "correctness",
        summary: "off-by-one drops the last element",
        failure_scenario: "a list of three yields two",
        confidence: "high",
      },
    ],
  });

  run("collect-findings.mjs", ["collect", dir]);
  assert.equal(clusters(dir).clusters[0].family, "correctness");
});

test("survives a malformed findings file without losing the other angles", () => {
  const dir = makeRun({
    "line-by-line": [
      {
        file: "src/a.mjs",
        line: 1,
        category: "correctness",
        summary: "off-by-one drops the last element",
        failure_scenario: "a list of three yields two",
        confidence: "high",
      },
    ],
  });
  fs.writeFileSync(path.join(dir, "findings", "broken.json"), "{ not json", "utf8");

  const res = run("collect-findings.mjs", ["collect", dir]);
  assert.equal(res.status, 0, "one bad file must not sink the run");
  assert.match(res.stderr, /skipping broken\.json/);
  assert.equal(clusters(dir).clusters.length, 1);
});

test("drops a candidate with no file or no summary rather than crashing", () => {
  const dir = makeRun({
    "line-by-line": [
      { line: 4, category: "correctness", summary: "no file given", failure_scenario: "x", confidence: "high" },
      { file: "src/a.mjs", line: 4, category: "correctness", failure_scenario: "x", confidence: "high" },
    ],
  });
  const res = run("collect-findings.mjs", ["collect", dir]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /no candidates/);
});

// ----------------------------------------------------------------- finalize

test("finalize drops rejected clusters, keeps confirmed and plausible, ranks confirmed first", () => {
  const dir = makeRun({
    "line-by-line": [
      { file: "src/a.mjs", line: 1, category: "correctness", summary: "alpha defect here", failure_scenario: "a", confidence: "high" },
      { file: "src/b.mjs", line: 2, category: "correctness", summary: "beta different problem", failure_scenario: "b", confidence: "high" },
      { file: "src/c.mjs", line: 3, category: "correctness", summary: "gamma unrelated third", failure_scenario: "c", confidence: "high" },
    ],
  });
  run("collect-findings.mjs", ["collect", dir]);
  const ids = clusters(dir).clusters.map((c) => c.id);
  assert.equal(ids.length, 3);

  fs.writeFileSync(
    path.join(dir, "verdicts", "b1.json"),
    JSON.stringify({
      verdicts: [
        { cluster_id: ids[0], verdict: "PLAUSIBLE", reason: "could not construct the input" },
        { cluster_id: ids[1], verdict: "REJECTED", reason: "a guard three lines above prevents it" },
        { cluster_id: ids[2], verdict: "CONFIRMED", reason: "traced it end to end" },
      ],
    }),
    "utf8"
  );

  const res = run("collect-findings.mjs", ["finalize", dir]);
  assert.equal(res.status, 0, res.stderr);

  const report = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
  assert.equal(report.stats.confirmed, 1);
  assert.equal(report.stats.plausible, 1);
  assert.equal(report.stats.rejected, 1);
  assert.equal(report.stats.unverified, 0);
  assert.equal(report.findings.length, 2, "rejected findings never reach the user");
  assert.equal(report.findings[0].verdict, "CONFIRMED", "confirmed outranks plausible");
});

test("finalize reports a cluster no verifier answered as unverified, not as clean", () => {
  const dir = makeRun({
    "line-by-line": [
      { file: "src/a.mjs", line: 1, category: "correctness", summary: "alpha defect here", failure_scenario: "a", confidence: "high" },
    ],
  });
  run("collect-findings.mjs", ["collect", dir]);
  run("collect-findings.mjs", ["finalize", dir]);

  const report = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
  assert.equal(report.stats.unverified, 1);
  assert.equal(report.findings.length, 0);
  assert.match(fs.readFileSync(path.join(dir, "report.md"), "utf8"), /Unverified/);
});

test("finalize keeps the verifier's corrected line over the finder's", () => {
  const dir = makeRun({
    "line-by-line": [
      { file: "src/a.mjs", line: 1, category: "correctness", summary: "alpha defect here", failure_scenario: "a", confidence: "high" },
    ],
  });
  run("collect-findings.mjs", ["collect", dir]);
  const id = clusters(dir).clusters[0].id;
  fs.writeFileSync(
    path.join(dir, "verdicts", "b1.json"),
    JSON.stringify({ verdicts: [{ cluster_id: id, verdict: "CONFIRMED", reason: "r", corrected_line: 87, corrected_file: "src/moved.mjs" }] }),
    "utf8"
  );
  run("collect-findings.mjs", ["finalize", dir]);

  const [finding] = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")).findings;
  assert.equal(finding.line, 87);
  assert.equal(finding.file, "src/moved.mjs");
});

test("an explicit null line leaves a candidate unanchored, not anchored at zero", () => {
  const dir = makeRun({
    "removed-behavior": [
      { file: "src/a.mjs", line: null, category: "removed-behavior", summary: "the guard is gone entirely", failure_scenario: "a", confidence: "high" },
    ],
  });
  run("collect-findings.mjs", ["collect", dir]);
  assert.equal(clusters(dir).clusters[0].line, null, "line 0 is not a line");
});

test("a verdict with corrected_line null keeps the cluster's own line", () => {
  const dir = makeRun({
    "line-by-line": [
      { file: "src/a.mjs", line: 42, category: "correctness", summary: "alpha defect here", failure_scenario: "a", confidence: "high" },
    ],
  });
  run("collect-findings.mjs", ["collect", dir]);
  const id = clusters(dir).clusters[0].id;
  fs.writeFileSync(
    path.join(dir, "verdicts", "b1.json"),
    JSON.stringify({ verdicts: [{ cluster_id: id, verdict: "CONFIRMED", reason: "r", corrected_line: null }] }),
    "utf8"
  );
  run("collect-findings.mjs", ["finalize", dir]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")).findings[0].line, 42);
});

test("merging an anchored member does not downgrade a cluster's confidence", () => {
  const dir = makeRun({
    "removed-behavior": [
      { file: "src/a.mjs", line: null, category: "removed-behavior", summary: "validatorFor drops the errors array entirely", failure_scenario: "a", confidence: "high" },
    ],
    "cross-file": [
      { file: "src/a.mjs", line: 12, category: "cross-file-break", summary: "callers of validatorFor still read the errors array", failure_scenario: "b", confidence: "low" },
    ],
  });
  run("collect-findings.mjs", ["collect", dir]);
  const [cluster] = clusters(dir).clusters;
  assert.equal(cluster.corroboration, 2, "these describe one defect");
  assert.equal(cluster.line, 12, "the cluster adopts the only line offered");
  assert.equal(cluster.confidence, "high", "but keeps its own confidence");
});

test("collect refuses a non-numeric --max-batches", () => {
  const dir = makeRun({
    "line-by-line": [
      { file: "src/a.mjs", line: 1, category: "correctness", summary: "alpha defect here", failure_scenario: "a", confidence: "high" },
    ],
  });
  const res = run("collect-findings.mjs", ["collect", dir, "--max-batches", "many"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--max-batches must be a positive number/);
});

test("finalize names the file when clusters.json is malformed", () => {
  const dir = makeRun({});
  fs.writeFileSync(path.join(dir, "clusters.json"), "null", "utf8");
  const res = run("collect-findings.mjs", ["finalize", dir]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /malformed/);
  assert.ok(!/Cannot destructure/.test(res.stderr), "a TypeError is not an error message");
});

test("finalize refuses an unknown verdict rather than silently ranking it", () => {
  const dir = makeRun({
    "line-by-line": [
      { file: "src/a.mjs", line: 1, category: "correctness", summary: "alpha defect here", failure_scenario: "a", confidence: "high" },
    ],
  });
  run("collect-findings.mjs", ["collect", dir]);
  const id = clusters(dir).clusters[0].id;
  fs.writeFileSync(
    path.join(dir, "verdicts", "b1.json"),
    JSON.stringify({ verdicts: [{ cluster_id: id, verdict: "probably fine", reason: "r" }] }),
    "utf8"
  );
  const res = run("collect-findings.mjs", ["finalize", dir]);
  assert.match(res.stderr, /unknown verdict/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")).stats.unverified, 1);
});

// ------------------------------------------------------------------- argv

test("a flag with a missing value refuses instead of eating the next flag", () => {
  const res = run("prepare-review.mjs", ["--out", "--json"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--out requires a value/);
});

test("collect-findings rejects an unknown command", () => {
  const res = run("collect-findings.mjs", ["summarise", ROOT]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown command/);
});

// ---------------------------------------------------------- orchestrator

test("a dry run needs no agent CLI, because it spawns nothing", () => {
  const repo = makeRepo();
  // Naming an agent that is certainly absent is what makes this test about the
  // no-agent branch on a developer machine, where a CLI is usually installed.
  // Dropping this argument once already turned the test into a no-op that kept
  // its name; CI, where no agent CLI exists at all, is the other half of it.
  const res = run("run-review.mjs", ["working", "--effort", "quick", "--dry-run", "--agent", "gemini"], repo);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /nothing spawned/);
  const runDir = /run dir (.+)/.exec(res.stdout)[1].trim();
  assert.ok(fs.existsSync(path.join(runDir, "prompts", "line-by-line.md")));
});

test("a rename is reported as one path git can actually open", () => {
  const repo = makeRepo();
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  // Long enough for git's rename detection to fire.
  fs.writeFileSync(
    path.join(repo, "original.mjs"),
    Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i};`).join("\n"),
    "utf8"
  );
  git("add", "-A");
  git("commit", "-m", "add a file worth renaming");
  git("mv", "original.mjs", "renamed.mjs");
  fs.appendFileSync(path.join(repo, "renamed.mjs"), "\nexport const extra = true;\n", "utf8");
  git("add", "-A");
  git("commit", "-m", "rename it");

  const res = run("prepare-review.mjs", ["HEAD~1..HEAD", "--json"], repo);
  assert.equal(res.status, 0, res.stderr);
  const context = JSON.parse(res.stdout);
  for (const file of context.files) {
    assert.ok(!file.path.includes("=>"), `"${file.path}" is a rename pseudo-path, not a file`);
    assert.ok(!file.path.includes("{"), `"${file.path}" is a rename pseudo-path, not a file`);
  }
  const renamed = context.files.find((f) => f.path === "renamed.mjs");
  assert.ok(renamed, "the new name must be the path");
  assert.equal(renamed.renamedFrom, "original.mjs");
});

test("a root-level generated directory is excluded from the code diff", () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, "dist"));
  fs.writeFileSync(path.join(repo, "dist", "bundle.mjs"), "export const generated = 1;\n", "utf8");
  fs.mkdirSync(path.join(repo, "src", "dist"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "dist", "nested.mjs"), "export const nested = 1;\n", "utf8");

  const res = run("prepare-review.mjs", ["working", "--json"], repo);
  const context = JSON.parse(res.stdout);
  const codeDiff = fs.readFileSync(context.paths.codeDiff, "utf8");
  assert.ok(!codeDiff.includes("dist/bundle.mjs"), "a root-level dist/ must be noise too");
  assert.ok(!codeDiff.includes("src/dist/nested.mjs"));
  assert.ok(codeDiff.includes("pending.mjs"), "real source must survive the exclusions");
});

test("a mistyped size limit is refused rather than silently disabling the guard", () => {
  const repo = makeRepo();
  const res = run("prepare-review.mjs", ["working", "--max-diff-mb", "8mb"], repo);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--max-diff-mb must be a positive number/);
});

test("an untracked file is reviewed, since git diff would not show it", () => {
  const repo = makeRepo();
  const res = run("prepare-review.mjs", ["working", "--json"], repo);
  assert.equal(res.status, 0, res.stderr);
  const context = JSON.parse(res.stdout);
  assert.ok(
    context.files.some((f) => f.path === "pending.mjs"),
    "the brand-new file is the one most worth reviewing"
  );
  assert.match(fs.readFileSync(context.paths.codeDiff, "utf8"), /export const underReview/);
});

test("prepare-review refuses an empty range instead of reviewing nothing", () => {
  const repo = makeRepo();
  fs.rmSync(path.join(repo, "pending.mjs"));
  const res = run("prepare-review.mjs", ["working"], repo);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /nothing to review/);
});

test("an unknown effort is refused rather than silently treated as standard", () => {
  const res = run("run-review.mjs", ["--effort", "exhaustive", "--dry-run"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--effort must be quick, standard or deep/);
});

test("an unknown angle name is refused rather than quietly skipped", () => {
  const repo = makeRepo();
  const res = run("run-review.mjs", ["working", "--angles", "line-by-line,telepathy", "--dry-run"], repo);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown angle/);
});

// --------------------------------------------------------------- installer

test("the pre-push hook installs, is executable, and is not global", () => {
  const repo = makeRepo();
  const res = run("install-client.mjs", ["githook", "--workspace", repo]);
  assert.equal(res.status, 0, res.stderr);

  const hook = path.join(repo, ".git", "hooks", "pre-push");
  assert.ok(fs.existsSync(hook));
  if (process.platform !== "win32") {
    assert.ok(fs.statSync(hook).mode & 0o111, "a hook git cannot execute is not a hook");
  }
});

test("installing over somebody else's pre-push hook is refused without --force", () => {
  const repo = makeRepo();
  const hook = path.join(repo, ".git", "hooks", "pre-push");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, "#!/bin/sh\n# somebody's existing hook\nexit 0\n", "utf8");

  const refused = run("install-client.mjs", ["githook", "--workspace", repo]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already exists/);
  assert.match(fs.readFileSync(hook, "utf8"), /somebody's existing hook/, "the hook must be untouched");

  const forced = run("install-client.mjs", ["githook", "--workspace", repo, "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(fs.readFileSync(hook, "utf8"), /deep-review pre-push hook/);
});

// The hook is a shell script, so these need a POSIX shell. Git ships one on
// Windows, but skip rather than fail if it is genuinely absent.
const HAVE_SH = spawnSync("sh", ["-c", "exit 0"], { encoding: "utf8" }).status === 0;

function pushToBareRemote(repo) {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "deep-review-bare-"));
  spawnSync("git", ["init", "-q", "--bare", bare], { encoding: "utf8" });
  spawnSync("git", ["remote", "add", "origin", bare], { cwd: repo, encoding: "utf8" });
  const res = spawnSync("git", ["push", "origin", "main"], { cwd: repo, encoding: "utf8" });
  return `${res.stdout || ""}${res.stderr || ""}`;
}

function recordRun(repo, { finished }) {
  const headSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  const runDir = path.join(repo, ".deep-review", "test-run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "context.json"), JSON.stringify({ headSha }, null, 2), "utf8");
  // prepare-review writes context.json before the first angle runs; only
  // finalize writes report.json. That difference is the whole point.
  if (finished) fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify({ findings: [] }), "utf8");
}

test("the hook warns when nothing has reviewed the commits being pushed", { skip: !HAVE_SH }, () => {
  const repo = makeRepo();
  run("install-client.mjs", ["githook", "--workspace", repo]);
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "-m", "work to push"], { cwd: repo });
  assert.match(pushToBareRemote(repo), /no completed review covers/);
});

test("the hook is not satisfied by a review that never finished", { skip: !HAVE_SH }, () => {
  const repo = makeRepo();
  run("install-client.mjs", ["githook", "--workspace", repo]);
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "-m", "work to push"], { cwd: repo });
  // A --dry-run, or a run that died on its first angle, leaves exactly this.
  recordRun(repo, { finished: false });
  assert.match(
    pushToBareRemote(repo),
    /no completed review covers/,
    "context.json alone is not evidence that any angle ran"
  );
});

test("the hook stays silent once a review has finished for that head", { skip: !HAVE_SH }, () => {
  const repo = makeRepo();
  run("install-client.mjs", ["githook", "--workspace", repo]);
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "-m", "work to push"], { cwd: repo });
  recordRun(repo, { finished: true });
  assert.doesNotMatch(pushToBareRemote(repo), /no completed review covers/);
});

test("the installed hook carries an absolute command, not one that only works here", () => {
  const repo = makeRepo();
  run("install-client.mjs", ["githook", "--workspace", repo]);
  const hook = fs.readFileSync(path.join(repo, ".git", "hooks", "pre-push"), "utf8");
  assert.ok(!hook.includes("{{DEEP_REVIEW_ROOT}}"), "the placeholder must be substituted");
  // Only what the hook actually prints matters; the comments may still discuss
  // the command that was wrong, and explaining why is worth keeping.
  const printed = hook.split("\n").filter((line) => line.trim().startsWith("printf")).join("\n");
  assert.match(printed, /run-review\.mjs/, "the remedy must name a command that exists");
  assert.doesNotMatch(printed, /npm run review/, "npm run review only works inside deep-review itself");
});

test("--global is refused for a per-repository target instead of doing nothing", () => {
  const repo = makeRepo();
  const res = run("install-client.mjs", ["githook", "--global"], repo);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no global location/);
});

test("the hook installer refuses a directory that is not a git repository", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-review-plain-"));
  const res = run("install-client.mjs", ["githook", "--workspace", dir]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not a git repository/);
});

// ------------------------------------------------------------- consistency

test("the angle list agrees across angles.json, agents/, SKILL.md and README", () => {
  const res = run("check-consistency.mjs", []);
  assert.equal(res.status, 0, res.stderr);
});

// A gate nobody has watched fail is a gate nobody knows works. These prove it
// catches the two drifts it was written for, by breaking a copy of the repo.
function copyRepoForGate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-review-gate-"));
  for (const entry of ["scripts", "agents", "skills", "clients", "README.md", "AGENTS.md"]) {
    fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
  }
  return dir;
}

function runGateIn(dir) {
  const res = spawnSync(process.execPath, [path.join(dir, "scripts", "check-consistency.mjs")], { encoding: "utf8" });
  return { status: res.status, stderr: res.stderr || "" };
}

test("the gate catches an effort count that prose and angles.json disagree on", () => {
  const dir = copyRepoForGate();
  assert.equal(runGateIn(dir).status, 0, "the copy must start clean");

  const readme = path.join(dir, "README.md");
  fs.writeFileSync(
    readme,
    fs.readFileSync(readme, "utf8").replace("`quick` (4 angles)", "`quick` (5 angles)"),
    "utf8"
  );
  const broken = runGateIn(dir);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /says `quick` runs 5 angles/);
});

test("the gate catches an agent declaring a category the collector cannot rank", () => {
  const dir = copyRepoForGate();
  const agent = path.join(dir, "agents", "dr-line-by-line.md");
  fs.writeFileSync(
    agent,
    fs.readFileSync(agent, "utf8").replace('"category": "correctness"', '"category": "telepathy"'),
    "utf8"
  );
  const broken = runGateIn(dir);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /declares category "telepathy"/);
});

test("every agent definition names its findings-file contract", () => {
  for (const file of fs.readdirSync(path.join(ROOT, "agents"))) {
    const text = fs.readFileSync(path.join(ROOT, "agents", file), "utf8");
    const key = file === "dr-verifier.md" ? "verdicts file" : "findings file";
    assert.ok(text.includes(key), `${file} never tells the agent about its ${key}`);
    assert.ok(
      /do not commit/i.test(text),
      `${file} does not forbid committing, and every agent must`
    );
  }
});
