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

function run(script, args) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: "utf8" });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
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

// ------------------------------------------------------------- consistency

test("the angle list agrees across angles.json, agents/, SKILL.md and README", () => {
  const res = run("check-consistency.mjs", []);
  assert.equal(res.status, 0, res.stderr);
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
