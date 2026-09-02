#!/usr/bin/env node
// collect-findings.mjs — the deterministic back half of a deep review.
//
// Ten independent finder angles reading the same diff will report the same
// defect more than once, in different words, sometimes off by a line or two.
// Deduplicating that by hand costs orchestrator context and is exactly the kind
// of mechanical judgement a script should make. Two subcommands:
//
//   collect <runDir>    findings/*.json  ->  clusters.json + verify batches
//   finalize <runDir>   verdicts/*.json  ->  report.json + report.md
//
// The split matters: `collect` runs between the finder wave and the verify
// wave, so the verifiers receive one cluster per real defect rather than one
// task per duplicate.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --------------------------------------------------------------- taxonomy

// Correctness-family findings assert the code is wrong; quality-family findings
// assert it could be better. They are ranked apart, and they earn different
// verification budgets, so the distinction is declared once here.
export const CORRECTNESS_CATEGORIES = new Set([
  "correctness",
  "removed-behavior",
  "cross-file-break",
  "platform",
  "wrapper",
  "security",
  "test-coverage",
]);

export const CATEGORY_RANK = new Map([
  ["correctness", 0],
  ["cross-file-break", 1],
  ["removed-behavior", 2],
  ["platform", 3],
  ["wrapper", 4],
  ["security", 5],
  ["convention", 6],
  ["test-coverage", 7],
  ["altitude", 8],
  ["reuse", 9],
  ["simplification", 10],
  ["efficiency", 11],
]);

const CONFIDENCE_RANK = new Map([["high", 0], ["medium", 1], ["low", 2]]);
const VERDICT_RANK = new Map([["CONFIRMED", 0], ["PLAUSIBLE", 1], ["REJECTED", 2]]);

function family(category) {
  return CORRECTNESS_CATEGORIES.has(category) ? "correctness" : "quality";
}

// ---------------------------------------------------------------- utilities

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    // A single malformed agent output must not sink the whole run - the other
    // nine angles still have something to say. Report it and carry on.
    process.stderr.write(`collect-findings: skipping ${path.basename(file)}: ${error.message}\n`);
    return null;
  }
}

function readJsonDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ name, data: readJson(path.join(dir, name)) }))
    .filter((entry) => entry.data !== null);
}

// Number(null) is 0 and Number.isFinite(0) is true, so an explicit
// "line": null used to anchor a finding at line 0 - which then rendered as
// "file:0" and killed the null-anchor merge path meant for angles that report
// an absence. One helper, used everywhere a line arrives from an agent.
function asLine(value) {
  if (value === null || value === undefined || value === "") return null;
  const line = Number(value);
  return Number.isFinite(line) && line > 0 ? line : null;
}

// Categories arrive from two different agents in two different files, and both
// spell them freely. One normaliser, used on both sides.
function normalizeCategory(value) {
  const category = String(value ?? "").trim().toLowerCase();
  return category || null;
}

function normalizePath(filePath) {
  return String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "to", "of", "in", "on", "at", "for",
  "and", "or", "but", "not", "no", "it", "its", "this", "that", "with", "as", "by", "from", "when",
  "if", "then", "than", "which", "what", "will", "would", "can", "could", "does", "do", "did",
]);

// Member access is split, not kept whole: one angle writes `validate.errors`
// and another writes "reads errors", and those must share the token `errors`.
// A crude plural trim closes the caller/callers, read/reads gap that otherwise
// costs a merge.
function tokenize(text) {
  const tokens = String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
    .map((token) => (token.length > 4 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token));
  return new Set(tokens);
}

// Overlap coefficient, not Jaccard: one angle writes a terse summary and
// another a long one for the same defect, and Jaccard punishes that length gap
// hard enough to miss the duplicate. Dividing by the smaller set asks the
// question that matters - is the shorter description contained in the longer?
function similarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  // Two findings sharing a single word share nothing meaningful.
  if (shared < 2) return 0;
  return shared / Math.min(a.size, b.size);
}

// ------------------------------------------------------------------ collect

const LINE_WINDOW = 8;
const SIMILARITY_THRESHOLD = 0.4;
// Angles that report an absence (a guard that is gone, a consumer that was
// never updated) anchor to "the nearest new line", which can land far from
// where another angle anchored the same defect. A near-identical description
// in the same file is duplicate enough to merge without the line check.
const STRONG_SIMILARITY = 0.65;

function loadCandidates(runDir) {
  const candidates = [];
  for (const { name, data } of readJsonDir(path.join(runDir, "findings"))) {
    const angle = data.angle || path.basename(name, ".json");
    const list = Array.isArray(data.candidates) ? data.candidates : [];
    for (const [index, raw] of list.entries()) {
      if (!raw || !raw.file || !raw.summary) {
        process.stderr.write(`collect-findings: ${angle} candidate ${index} has no file/summary; dropped\n`);
        continue;
      }
      // Trimmed: a category arriving with stray whitespace matched no entry
      // in the rank map and silently left the correctness family.
      const category = normalizeCategory(raw.category) || "correctness";
      candidates.push({
        id: `${angle}-${index + 1}`,
        angle,
        file: normalizePath(raw.file),
        line: asLine(raw.line),
        category,
        family: family(category),
        summary: String(raw.summary).trim(),
        failure_scenario: String(raw.failure_scenario || "").trim(),
        evidence: String(raw.evidence || "").trim(),
        confidence: ["high", "medium", "low"].includes(String(raw.confidence).toLowerCase())
          ? String(raw.confidence).toLowerCase()
          : "medium",
        tokens: tokenize(`${raw.summary} ${raw.failure_scenario || ""}`),
      });
    }
  }
  return candidates;
}

function clusterCandidates(candidates) {
  const clusters = [];
  for (const candidate of candidates) {
    const match = clusters.find((cluster) => {
      if (cluster.file !== candidate.file) return false;
      // Same family only: a correctness bug and a "this could be simpler" note
      // on the same line are two separate pieces of feedback, not a duplicate.
      if (cluster.family !== candidate.family) return false;
      const closeEnough =
        cluster.line === null ||
        candidate.line === null ||
        Math.abs(cluster.line - candidate.line) <= LINE_WINDOW;
      return cluster.members.some((member) => {
        const score = similarity(member.tokens, candidate.tokens);
        return score >= STRONG_SIMILARITY || (closeEnough && score >= SIMILARITY_THRESHOLD);
      });
    });

    if (match) {
      match.members.push(candidate);
      // Keep the most confident member's line as the cluster anchor.
      // An unanchored cluster adopts the first line a member supplies, but
      // never inherits that member's confidence: doing both let a low-confidence
      // member demote a high-confidence cluster purely by arriving with a line.
      if (match.line === null && candidate.line !== null) match.line = candidate.line;
      if (CONFIDENCE_RANK.get(candidate.confidence) < CONFIDENCE_RANK.get(match.confidence)) {
        match.confidence = candidate.confidence;
        if (candidate.line !== null) match.line = candidate.line;
      }
      if ((CATEGORY_RANK.get(candidate.category) ?? 99) < (CATEGORY_RANK.get(match.category) ?? 99)) {
        match.category = candidate.category;
      }
      continue;
    }

    clusters.push({
      id: `c${clusters.length + 1}`,
      file: candidate.file,
      line: candidate.line,
      category: candidate.category,
      family: candidate.family,
      confidence: candidate.confidence,
      members: [candidate],
    });
  }

  for (const cluster of clusters) {
    cluster.angles = [...new Set(cluster.members.map((m) => m.angle))].sort();
    // Corroboration is real signal: a defect three independent angles found is
    // far more likely to survive verification than one only a single angle saw.
    cluster.corroboration = cluster.angles.length;
    const best = [...cluster.members].sort(
      (a, b) => CONFIDENCE_RANK.get(a.confidence) - CONFIDENCE_RANK.get(b.confidence)
    )[0];
    cluster.summary = best.summary;
    cluster.failure_scenario = best.failure_scenario;
    cluster.evidence = best.evidence;
    cluster.members = cluster.members.map(({ tokens, ...rest }) => rest);
  }

  return clusters.sort((a, b) => {
    const byFamily = (a.family === "correctness" ? 0 : 1) - (b.family === "correctness" ? 0 : 1);
    if (byFamily !== 0) return byFamily;
    const byCategory = (CATEGORY_RANK.get(a.category) ?? 99) - (CATEGORY_RANK.get(b.category) ?? 99);
    if (byCategory !== 0) return byCategory;
    if (a.corroboration !== b.corroboration) return b.corroboration - a.corroboration;
    return CONFIDENCE_RANK.get(a.confidence) - CONFIDENCE_RANK.get(b.confidence);
  });
}

// Batching, not one agent per cluster: 40 clusters must not become 40 agents.
// Correctness clusters batch small (deep reading per item); quality clusters
// batch large (a judgement call, not an investigation).
function buildBatches(clusters, { maxBatches = 6 } = {}) {
  const correctness = clusters.filter((c) => c.family === "correctness");
  const quality = clusters.filter((c) => c.family !== "correctness");
  const batches = [];

  const chunk = (list, size, prefix) => {
    for (let i = 0; i < list.length; i += size) {
      batches.push({
        id: `${prefix}${batches.length + 1}`,
        family: prefix === "b" ? "correctness" : "quality",
        clusterIds: list.slice(i, i + size).map((c) => c.id),
      });
    }
  };

  chunk(correctness, 4, "b");
  chunk(quality, 8, "q");

  if (batches.length <= maxBatches) return batches;

  // Over budget: re-chunk into exactly maxBatches, keeping family separation
  // where it still fits rather than interleaving unrelated work.
  const merged = [];
  const perBatch = Math.ceil(clusters.length / maxBatches);
  for (let i = 0; i < clusters.length; i += perBatch) {
    const slice = clusters.slice(i, i + perBatch);
    merged.push({
      id: `b${merged.length + 1}`,
      family: slice.every((c) => c.family === "quality") ? "quality" : "mixed",
      clusterIds: slice.map((c) => c.id),
    });
  }
  return merged;
}

function collect(runDir, opts) {
  const candidates = loadCandidates(runDir);
  if (candidates.length === 0) {
    const empty = { clusters: [], batches: [], stats: { candidates: 0, clusters: 0, angles: 0 } };
    fs.writeFileSync(path.join(runDir, "clusters.json"), `${JSON.stringify(empty, null, 2)}\n`, "utf8");
    process.stdout.write("no candidates reported by any angle\n");
    return;
  }

  const clusters = clusterCandidates(candidates);
  const batches = buildBatches(clusters, { maxBatches: opts.maxBatches });
  const payload = {
    clusters,
    batches,
    stats: {
      candidates: candidates.length,
      clusters: clusters.length,
      angles: new Set(candidates.map((c) => c.angle)).size,
      correctness: clusters.filter((c) => c.family === "correctness").length,
      quality: clusters.filter((c) => c.family !== "correctness").length,
      collapsed: candidates.length - clusters.length,
    },
  };
  fs.writeFileSync(path.join(runDir, "clusters.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `candidates  ${payload.stats.candidates} from ${payload.stats.angles} angles`,
      `clusters    ${payload.stats.clusters} (${payload.stats.collapsed} duplicates collapsed)`,
      `            ${payload.stats.correctness} correctness, ${payload.stats.quality} quality`,
      `batches     ${batches.length}`,
      `written     ${path.join(runDir, "clusters.json")}`,
      "",
      ...batches.map((b) => `  ${b.id} [${b.family}] ${b.clusterIds.join(", ")}`),
      "",
    ].join("\n")
  );
}

// ----------------------------------------------------------------- finalize

function finalize(runDir, opts) {
  const clustersFile = path.join(runDir, "clusters.json");
  if (!fs.existsSync(clustersFile)) throw new Error(`no clusters.json in ${runDir}; run "collect" first`);
  const parsed = readJson(clustersFile);
  if (!parsed || !Array.isArray(parsed.clusters)) {
    throw new Error(`${clustersFile} is missing or malformed; run "collect" again`);
  }
  const { clusters } = parsed;

  const verdicts = new Map();
  for (const { name, data } of readJsonDir(path.join(runDir, "verdicts"))) {
    const list = Array.isArray(data.verdicts) ? data.verdicts : [];
    for (const verdict of list) {
      if (!verdict || !verdict.cluster_id) continue;
      const upper = String(verdict.verdict || "").toUpperCase();
      if (!VERDICT_RANK.has(upper)) {
        process.stderr.write(`collect-findings: ${name} gave cluster ${verdict.cluster_id} an unknown verdict "${verdict.verdict}"\n`);
        continue;
      }
      verdicts.set(verdict.cluster_id, { ...verdict, verdict: upper });
    }
  }

  const findings = [];
  const unverified = [];
  for (const cluster of clusters) {
    const verdict = verdicts.get(cluster.id);
    if (!verdict) {
      unverified.push(cluster);
      continue;
    }
    if (verdict.verdict === "REJECTED") continue;
    findings.push({
      cluster_id: cluster.id,
      file: verdict.corrected_file ? normalizePath(verdict.corrected_file) : cluster.file,
      line: asLine(verdict.corrected_line) ?? cluster.line,
      // The verifier writes this field too, and models capitalise freely.
      // loadCandidates() normalises the finder side; skipping it here let a
      // CONFIRMED "Correctness" miss the lowercase-keyed rank map and sort
      // below every confirmed efficiency note.
      category: normalizeCategory(verdict.category) || cluster.category,
      verdict: verdict.verdict,
      summary: verdict.summary || cluster.summary,
      // Falling back to the finder's summary put the retracted claim next to
      // the corrected one whenever a verifier downgraded the wording.
      short_summary: (verdict.short_summary || verdict.summary || cluster.summary).slice(0, 60),
      failure_scenario: verdict.failure_scenario || cluster.failure_scenario,
      reason: verdict.reason || "",
      angles: cluster.angles,
      corroboration: cluster.corroboration,
    });
  }

  findings.sort((a, b) => {
    const byVerdict = VERDICT_RANK.get(a.verdict) - VERDICT_RANK.get(b.verdict);
    if (byVerdict !== 0) return byVerdict;
    const byCategory = (CATEGORY_RANK.get(a.category) ?? 99) - (CATEGORY_RANK.get(b.category) ?? 99);
    if (byCategory !== 0) return byCategory;
    return b.corroboration - a.corroboration;
  });

  const report = {
    findings,
    unverified: unverified.map((c) => ({ cluster_id: c.id, file: c.file, line: c.line, summary: c.summary })),
    stats: {
      clusters: clusters.length,
      verified: verdicts.size,
      confirmed: findings.filter((f) => f.verdict === "CONFIRMED").length,
      plausible: findings.filter((f) => f.verdict === "PLAUSIBLE").length,
      rejected: [...verdicts.values()].filter((v) => v.verdict === "REJECTED").length,
      unverified: unverified.length,
    },
  };
  fs.writeFileSync(path.join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const section = (title, list) =>
    list.length === 0
      ? ""
      : `\n## ${title}\n\n${list
          .map(
            (f, i) =>
              `${i + 1}. **${f.file}${f.line ? `:${f.line}** ` : "** "}— ${f.summary}\n` +
              `   - *${f.category}* · found by ${f.angles.join(", ")}\n` +
              (f.failure_scenario ? `   - Failure: ${f.failure_scenario}\n` : "") +
              (f.reason ? `   - Verifier: ${f.reason}\n` : "")
          )
          .join("\n")}`;

  const markdown =
    `# Deep review report\n\n` +
    `${report.stats.confirmed} confirmed, ${report.stats.plausible} plausible, ` +
    `${report.stats.rejected} rejected out of ${report.stats.clusters} clusters` +
    `${report.stats.unverified ? `, ${report.stats.unverified} unverified` : ""}.\n` +
    section("Confirmed", findings.filter((f) => f.verdict === "CONFIRMED")) +
    section("Plausible", findings.filter((f) => f.verdict === "PLAUSIBLE")) +
    (unverified.length
      ? `\n## Unverified\n\n${unverified.map((c) => `- ${c.file}${c.line ? `:${c.line}` : ""} — ${c.summary}`).join("\n")}\n`
      : "");
  fs.writeFileSync(path.join(runDir, "report.md"), markdown, "utf8");

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `confirmed   ${report.stats.confirmed}`,
      `plausible   ${report.stats.plausible}`,
      `rejected    ${report.stats.rejected}`,
      `unverified  ${report.stats.unverified}`,
      `written     ${path.join(runDir, "report.json")}, ${path.join(runDir, "report.md")}`,
      "",
    ].join("\n")
  );
}

// --------------------------------------------------------------------- cli

const USAGE = `Usage: node collect-findings.mjs <collect|finalize> <runDir> [--json] [--max-batches <n>]

  collect    read findings/*.json, deduplicate across angles, write clusters.json
             and the verify batches the orchestrator fans out next
  finalize   read verdicts/*.json, drop REJECTED, rank the survivors, write
             report.json and report.md
`;

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  const [command, runDirArg, ...rest] = argv;
  const opts = { json: false, maxBatches: 6 };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--json") opts.json = true;
    else if (rest[i] === "--max-batches") {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--max-batches requires a value");
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 1) throw new Error("--max-batches must be a positive number");
      opts.maxBatches = parsed;
      i += 1;
    } else throw new Error(`unknown argument: ${rest[i]}`);
  }
  if (!runDirArg) throw new Error("a run directory is required");
  const runDir = path.resolve(runDirArg);
  if (!fs.existsSync(runDir)) throw new Error(`run directory does not exist: ${runDir}`);

  if (command === "collect") collect(runDir, opts);
  else if (command === "finalize") finalize(runDir, opts);
  else throw new Error(`unknown command: ${command}`);
}

// Only run when invoked as a command. The consistency gate imports this module
// to compare the real category maps, instead of regex-scraping them out of the
// source text - which could only ever check key spellings and could not see the
// correctness/quality split at all.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`collect-findings: ${error.message}\n`);
    process.exitCode = 1;
  }
}
