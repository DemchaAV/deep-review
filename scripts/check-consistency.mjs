#!/usr/bin/env node
// check-consistency.mjs — the gate that keeps the four copies of the angle list
// from drifting apart.
//
// The same set of angles is spelled out in four places, because four different
// readers need it: angles.json (the runner), the agents/ directory (the agent
// definitions themselves), SKILL.md (the in-Claude orchestrator, which reads
// prose), and the README (a human). Nothing forces them to agree, and a review
// that silently runs nine angles while claiming ten is exactly the class of
// defect this project exists to catch. So: prove it, in CI.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const problems = [];
const fail = (message) => problems.push(message);

const angles = JSON.parse(fs.readFileSync(path.join(HERE, "angles.json"), "utf8"));
const skill = fs.readFileSync(path.join(ROOT, "skills", "deep-review", "SKILL.md"), "utf8");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

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

// 5. Every pitfall file the runner can select must exist.
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
  ["quick", "standard", "deep"].map((effort) => [effort, angles.angles.filter((a) => a.efforts.includes(effort)).map((a) => a.id)])
);
for (const [effort, list] of Object.entries(byEffort)) {
  if (list.length === 0) fail(`effort preset "${effort}" selects no angles`);
}
for (const [narrow, wide] of [["quick", "standard"], ["standard", "deep"]]) {
  const missing = byEffort[narrow].filter((id) => !byEffort[wide].includes(id));
  if (missing.length) fail(`effort "${narrow}" includes ${missing.join(", ")} but "${wide}" does not, breaking the documented subset relationship`);
}

// 7. Antigravity caps a workflow file at 12,000 characters. A file over that is
//    silently truncated, which would cut the protocol off mid-step.
const antigravityWorkflow = path.join(ROOT, "clients", "antigravity", "workflows", "deep-review.md");
if (fs.existsSync(antigravityWorkflow)) {
  const size = fs.readFileSync(antigravityWorkflow, "utf8").length;
  if (size > 12000) fail(`clients/antigravity/workflows/deep-review.md is ${size} chars, over Antigravity's 12,000 limit`);
}

if (problems.length > 0) {
  process.stderr.write(`check-consistency: ${problems.length} problem(s)\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exitCode = 1;
} else {
  const counts = Object.entries(byEffort).map(([e, l]) => `${e} ${l.length}`).join(", ");
  process.stdout.write(`check-consistency: ok - ${angles.angles.length} angles (${counts}), ${declaredAgents.size} agent definitions\n`);
}
