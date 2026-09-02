#!/usr/bin/env node
// check-consistency.mjs — the gate that stops the restated angle list drifting.
//
// The same set of angles is spelled out for several different readers:
// angles.json (the runner), the agents/ directory (the definitions themselves),
// SKILL.md (the in-Claude orchestrator, which reads prose and cannot read JSON),
// the README (a human), and each client adapter under clients/. Nothing forces
// them to agree, and a review that silently runs nine angles while claiming ten
// is exactly the class of defect this project exists to catch. So: prove it, in
// CI.
//
// The prose files are DISCOVERED, never listed. An earlier version seeded a
// fixed array, and the two client adapters then landed with their own stale
// copies of the effort counts while this gate reported success.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORY_RANK, CORRECTNESS_CATEGORIES } from "./collect-findings.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const problems = [];
const fail = (message) => problems.push(message);

const angles = JSON.parse(fs.readFileSync(path.join(HERE, "angles.json"), "utf8"));
const skill = fs.readFileSync(path.join(ROOT, "skills", "deep-review", "SKILL.md"), "utf8");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

// Everything that is not generated output, a dependency, or git's own storage.
const SKIP_DIRECTORIES = new Set([".git", ".deep-review", "node_modules", "dist", "build"]);

function markdownFiles(dir = ROOT) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(full));
    else if (entry.name.endsWith(".md")) {
      found.push({ rel: path.relative(ROOT, full).split(path.sep).join("/"), text: fs.readFileSync(full, "utf8") });
    }
  }
  return found;
}

const declaredAgents = new Set([...angles.angles.map((a) => a.agent), angles.verifier]);

// 1. Every declared agent has a definition file whose frontmatter name matches.
for (const agent of declaredAgents) {
  const file = path.join(ROOT, "agents", `${agent}.md`);
  if (!fs.existsSync(file)) {
    fail(`angles.json declares agent "${agent}" but agents/${agent}.md does not exist`);
    continue;
  }
  const frontmatterName = /^---\r?\n(?:[\s\S]*?\r?\n)?name:\s*(\S+)/m.exec(fs.readFileSync(file, "utf8"));
  if (!frontmatterName) fail(`agents/${agent}.md has no name in its frontmatter`);
  else if (frontmatterName[1] !== agent) {
    fail(`agents/${agent}.md declares name "${frontmatterName[1]}" but is referenced as "${agent}"`);
  }
}

// 2. Every agent definition on disk is declared - an orphan is either a typo or
//    an angle someone forgot to wire up, and both are silent today.
for (const file of fs.readdirSync(path.join(ROOT, "agents"))) {
  if (!file.endsWith(".md")) continue;
  const agent = path.basename(file, ".md");
  if (!declaredAgents.has(agent)) fail(`agents/${file} exists but no angle in angles.json uses it`);
}

// 3. The in-Claude orchestrator has to name every agent, or it cannot spawn it.
for (const agent of declaredAgents) {
  if (!skill.includes(agent)) fail(`SKILL.md never mentions "${agent}", so the orchestrator cannot spawn it`);
}

// 4. The README table has to list every angle, or the docs undercount.
for (const angle of angles.angles) {
  if (!readme.includes(`| ${angle.id} |`)) fail(`README.md has no table row for angle "${angle.id}"`);
}

// 5. Every pitfall file the runner can select must exist, and every file that
//    exists must be reachable from some language.
const pitfallDir = path.join(ROOT, "skills", "deep-review", "references", "pitfalls");
const referenced = new Set([...Object.values(angles.pitfallsByLanguage).flat(), ...angles.pitfallsFallback]);
for (const name of referenced) {
  if (!fs.existsSync(path.join(pitfallDir, name))) fail(`angles.json points at pitfalls/${name}, which does not exist`);
}
for (const file of fs.readdirSync(pitfallDir)) {
  if (file.endsWith(".md") && !referenced.has(file)) {
    fail(`pitfalls/${file} exists but no language maps to it, so it is never read`);
  }
}

// 6. Effort presets have to be non-empty and ordered by inclusion, since the
//    docs promise quick is a subset of standard is a subset of deep.
const byEffort = Object.fromEntries(
  ["quick", "standard", "deep"].map((effort) => [
    effort,
    angles.angles.filter((a) => a.efforts.includes(effort)).map((a) => a.id),
  ])
);
for (const [effort, list] of Object.entries(byEffort)) {
  if (list.length === 0) fail(`effort preset "${effort}" selects no angles`);
}
for (const [narrow, wide] of [["quick", "standard"], ["standard", "deep"]]) {
  const missing = byEffort[narrow].filter((id) => !byEffort[wide].includes(id));
  if (missing.length) {
    fail(`effort "${narrow}" includes ${missing.join(", ")} but "${wide}" does not, breaking the documented subset relationship`);
  }
}

// 7. Effort counts written in prose must match the presets. Every such claim
//    uses the form `quick` (4 angles), which is the one shape this can check.
//    The count of claims is asserted too: if it ever drops to zero the rule has
//    become a no-op that still reports success, which is how a gate quietly
//    stops gating.
const EFFORT_CLAIM = /`(quick|standard|deep)`\s*\((\d+)\s*angles?/g;
const prose = markdownFiles();
let effortClaims = 0;
for (const { rel, text } of prose) {
  for (const [, effort, claimed] of text.matchAll(EFFORT_CLAIM)) {
    effortClaims += 1;
    if (Number(claimed) !== byEffort[effort].length) {
      fail(`${rel} says \`${effort}\` runs ${claimed} angles; angles.json says ${byEffort[effort].length}`);
    }
  }
}
if (effortClaims === 0) {
  fail("no effort count in the gated `quick` (N angles) form was found anywhere, so rule 7 checked nothing");
}

// 8. Every category an agent declares must be one collect-findings ranks, and
//    the correctness family must be a subset of the ranked set. An unknown
//    category is not rejected there: it falls through to the quality family, is
//    batched at low scrutiny and sorts last, so a typo silently demotes a
//    correctness defect. The maps are imported rather than scraped out of the
//    source text, so this compares the real values.
for (const category of CORRECTNESS_CATEGORIES) {
  if (!CATEGORY_RANK.has(category)) {
    fail(`"${category}" is in the correctness family but CATEGORY_RANK does not rank it`);
  }
}
for (const agent of declaredAgents) {
  const file = path.join(ROOT, "agents", `${agent}.md`);
  if (!fs.existsSync(file)) continue;
  for (const [, category] of fs.readFileSync(file, "utf8").matchAll(/"category":\s*"([a-z-]+)"/g)) {
    if (!CATEGORY_RANK.has(category)) {
      fail(`agents/${agent}.md declares category "${category}", which CATEGORY_RANK does not rank`);
    }
  }
}

// 9. The in-Claude orchestrator picks a pitfall sheet from a table it carries in
//    prose, which is a hand-copy of angles.json's map. A language added to the
//    map but not the table leaves that path on the generic fallback.
for (const language of Object.keys(angles.pitfallsByLanguage)) {
  if (!skill.includes(language)) {
    fail(`angles.json maps "${language}" to a pitfall sheet, but SKILL.md's table never names it`);
  }
}

// 10. Antigravity caps a workflow file at 12,000 characters; over that it is
//     silently truncated, which would cut the protocol off mid-step. Not
//     wrapped in an existence check: if the file is renamed, this rule must
//     fail loudly rather than evaporate.
const antigravityWorkflow = path.join(ROOT, "clients", "antigravity", "workflows", "deep-review.md");
if (!fs.existsSync(antigravityWorkflow)) {
  fail(`clients/antigravity/workflows/deep-review.md is missing; if it moved, update rule 10 with it`);
} else {
  const size = fs.readFileSync(antigravityWorkflow, "utf8").length;
  if (size > 12000) {
    fail(`clients/antigravity/workflows/deep-review.md is ${size} chars, over Antigravity's 12,000 limit`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`check-consistency: ${problems.length} problem(s)\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exitCode = 1;
} else {
  const counts = Object.entries(byEffort).map(([e, l]) => `${e} ${l.length}`).join(", ");
  process.stdout.write(
    `check-consistency: ok - ${angles.angles.length} angles (${counts}), ${declaredAgents.size} agent definitions, ` +
      `${prose.length} prose files, ${effortClaims} gated effort claims\n`
  );
}
