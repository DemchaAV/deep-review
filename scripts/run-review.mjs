#!/usr/bin/env node
// run-review.mjs — the portable orchestrator.
//
// Inside Claude Code the fan-out is native: ten Agent calls in one message and
// the harness runs them concurrently. Everywhere else - Codex, Antigravity, a
// plain terminal, CI - there is no such primitive, but every one of those
// environments can run a shell command, and every one of them ships a headless
// CLI. So this script does the fan-out itself, by spawning one process per
// angle and waiting on all of them.
//
//   node run-review.mjs [target] [--agent claude|codex|gemini] [--effort ...]
//
// The prompts are written to files and the CLI is told to read one, rather than
// passed on the command line. Angle prompts run to several kilobytes, and
// argument-length limits and quoting rules differ on every shell and platform;
// a path does not.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const ANGLES = JSON.parse(fs.readFileSync(path.join(HERE, "angles.json"), "utf8"));

// --------------------------------------------------------------- agent CLIs

// Each entry says how to run that CLI headlessly with permission to write the
// one file the agent is asked to produce. The prompt is always a short pointer
// at a prompt file, named relative to the working directory the child is given.
const AGENTS = {
  claude: {
    bin: "claude",
    args: (prompt, { model }) => [
      "-p",
      prompt,
      "--permission-mode",
      "acceptEdits",
      ...(model ? ["--model", model] : []),
    ],
  },
  codex: {
    bin: "codex",
    // codex exec takes the prompt positionally; -p there means --profile.
    args: (prompt, { model }) => [
      "exec",
      prompt,
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      ...(model ? ["--model", model] : []),
    ],
  },
  gemini: {
    bin: "gemini",
    args: (prompt, { model }) => [
      "-p",
      prompt,
      "--approval-mode",
      "auto_edit",
      ...(model ? ["--model", model] : []),
    ],
  },
};

const IS_WINDOWS = process.platform === "win32";

function which(bin) {
  // where.exe and which are real executables, so no shell is needed - and not
  // asking for one avoids passing an unescaped argument through a command line.
  const probe = spawnSync(IS_WINDOWS ? "where" : "which", [bin], { encoding: "utf8" });
  return probe.status === 0;
}

// The agent CLIs are npm shims, which on Windows are .cmd files that only a
// shell can execute - and a shell concatenates arguments without escaping them,
// so a run directory under "C:\My Projects\..." would break every spawn. Quote
// each argument ourselves rather than hoping no path has a space in it. The
// binary is quoted too: node itself lives under "C:\Program Files".
function winQuote(arg) {
  if (arg === "") return '""';
  if (!/[\s"^&|<>()]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

// cmd.exe cannot be quoted out of everything. It expands %VAR% inside quotes,
// and it does not understand \" as an escaped quote the way a C runtime does -
// one embedded quote flips the parity for the whole rest of the line, and a
// later & or | then runs as a command separator. So rather than quote harder,
// the caller keeps metacharacters out of the arguments entirely (prompt paths
// are relative to cwd, which makes them plain). This is the assertion that the
// caller kept its side of that bargain.
const SHELL_UNSAFE = /["%&|<>^]/;

function assertShellSafe(parts) {
  const offender = parts.find((part) => SHELL_UNSAFE.test(part));
  if (offender) {
    throw new Error(
      `refusing to pass "${offender}" through the Windows shell - it contains a character ` +
        `cmd.exe cannot be reliably quoted against. Move the repository somewhere without ` +
        `" % & | < > or ^ in its path.`
    );
  }
}

// One pre-quoted command string rather than a binary plus an args array: with
// `shell: true` Node would join the array itself, unescaped, on top of whatever
// we did - and warns about exactly that (DEP0190).
function spawnAgent(bin, args, options) {
  if (!IS_WINDOWS) return spawn(bin, args, { ...options, shell: false });
  assertShellSafe([bin, ...args]);
  return spawn([bin, ...args].map(winQuote).join(" "), { ...options, shell: true });
}

function detectAgent() {
  for (const name of ["claude", "codex", "gemini"]) if (which(name)) return name;
  return null;
}

// ------------------------------------------------------------------ arg parse

function parseArgs(argv) {
  const opts = {
    target: null,
    agent: null,
    effort: "standard",
    angles: null,
    concurrency: 5,
    model: null,
    note: null,
    verify: true,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === "--agent") opts.agent = next();
    else if (arg === "--effort") opts.effort = next();
    else if (arg === "--angles") opts.angles = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--concurrency") opts.concurrency = Number(next());
    else if (arg === "--model") opts.model = next();
    else if (arg === "--note") opts.note = next();
    else if (arg === "--no-verify") opts.verify = false;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (!arg.startsWith("-") && opts.target === null) opts.target = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!["quick", "standard", "deep"].includes(opts.effort)) {
    throw new Error(`--effort must be quick, standard or deep (got "${opts.effort}")`);
  }
  if (!Number.isFinite(opts.concurrency) || opts.concurrency < 1) {
    throw new Error("--concurrency must be a positive number");
  }
  return opts;
}

const USAGE = `Usage: node run-review.mjs [target] [options]

Runs the full deep review by spawning one headless agent process per angle.

  target             working (default) | branch | <PR number> | <ref> | <base>..<head>

  --agent <name>     claude | codex | gemini   (default: the first one installed)
  --effort <level>   quick (4 angles) | standard (7, default) | deep (10)
  --angles a,b,c     explicit angle list, overrides --effort
  --concurrency <n>  how many agent processes at once (default 5)
  --model <name>     model to pass to the agent CLI
  --note "<text>"    a reviewer's note handed to every angle
  --no-verify        stop after the finder wave, skip the verify pass
  --dry-run          write the prompts and print the plan, spawn nothing
`;

// --------------------------------------------------------------- prompt build

function stripFrontmatter(markdown) {
  // Agent definitions carry YAML frontmatter for the Claude Code loader. The
  // body is the prompt; the frontmatter is loader metadata and would only
  // confuse a CLI that never asked for it.
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(markdown);
  return match ? markdown.slice(match[0].length).trimStart() : markdown;
}

function pitfallFiles(primaryLanguage) {
  const names = ANGLES.pitfallsByLanguage[primaryLanguage] || ANGLES.pitfallsFallback;
  return names.map((name) =>
    path.join(PLUGIN_ROOT, "skills", "deep-review", "references", "pitfalls", name)
  );
}

function buildFinderPrompt(angle, context, opts) {
  const body = stripFrontmatter(
    fs.readFileSync(path.join(PLUGIN_ROOT, "agents", `${angle.agent}.md`), "utf8")
  );
  const contextMd = fs.readFileSync(path.join(context.outDir, "context.md"), "utf8");
  const findingsFile = path.join(context.paths.findings, `${angle.id}.json`);

  const extras = [];
  if (angle.needsPitfalls) {
    extras.push(`Pitfall reference: ${pitfallFiles(context.primaryLanguage).join("\n                   ")}`);
  }
  if (angle.needsGoverningDocs) {
    const docs = context.governingDocs;
    extras.push(
      [
        "Governing documents to read, in this order:",
        ...(docs.user ? [`  1. user-level, may hold rules scoped to another repo: ${docs.user}`] : []),
        ...docs.repo.map((doc, i) => `  ${(docs.user ? 2 : 1) + i}. in-repo: ${doc}`),
        docs.repo.length === 0 && !docs.user ? "  (none found - say so and report nothing)" : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  if (opts.note) extras.push(`Reviewer's note: ${opts.note}`);

  return [
    body.trimEnd(),
    "",
    "---",
    "",
    "# This run",
    "",
    contextMd.replace(/^# Run context\n/, "").trim(),
    "",
    `**Your findings file**: ${findingsFile}`,
    "",
    extras.join("\n\n"),
    "",
    "Write that file before you finish, even if it holds an empty candidate list.",
    "",
  ].join("\n");
}

function buildVerifierPrompt(batch, context) {
  const body = stripFrontmatter(
    fs.readFileSync(path.join(PLUGIN_ROOT, "agents", `${ANGLES.verifier}.md`), "utf8")
  );
  return [
    body.trimEnd(),
    "",
    "---",
    "",
    "# This batch",
    "",
    `Worktree: ${context.worktree} - run every command from there.`,
    `Clusters file: ${path.join(context.outDir, "clusters.json")}`,
    `Your batch: ${batch.id}`,
    `Verify exactly these clusters: ${batch.clusterIds.join(", ")}`,
    `Your verdicts file: ${path.join(context.paths.verdicts, `${batch.id}.json`)}`,
    `Head: ${context.headSha}`,
    "",
    "Write that file before you finish, with one entry per cluster id above.",
    "",
  ].join("\n");
}

// ------------------------------------------------------------------ spawning

function runOne({ label, promptRel, agent, model, cwd, logFile }) {
  return new Promise((resolve) => {
    const spec = AGENTS[agent];
    const started = Date.now();
    // The prompt names the file by a path relative to cwd. Absolute paths drag
    // the whole repository location into the command line, and any space or
    // ampersand in it becomes a shell problem; a relative path under the run
    // directory is plain ASCII by construction.
    const prompt = `Read ${promptRel} and follow it exactly.`;
    const child = spawnAgent(spec.bin, spec.args(prompt, { model }), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    child.on("error", (error) => {
      fs.writeFileSync(logFile, `spawn failed: ${error.message}\n`, "utf8");
      resolve({ label, ok: false, code: null, seconds: 0, error: error.message });
    });
    child.on("close", (code) => {
      fs.writeFileSync(logFile, Buffer.concat(chunks).toString("utf8"), "utf8");
      resolve({ label, ok: code === 0, code, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

// A pool rather than Promise.all over everything: ten simultaneous model
// sessions is a good way to meet a rate limit, and a rate-limited agent fails
// silently as "no findings", which looks exactly like a clean angle.
async function runPool(tasks, concurrency, onDone) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      const result = await runOne(tasks[index]);
      results.push(result);
      onDone(result, results.length, tasks.length);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------- main

function node(script, args) {
  const res = spawnSync(process.execPath, [path.join(HERE, script), ...args], { encoding: "utf8" });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${script} failed:\n${res.stderr || res.stdout}`);
  return res.stdout;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  // A dry run spawns nothing, so it must not require an agent CLI to exist:
  // inspecting the prompts and the plan is exactly what you do on a machine
  // that has no agent installed, CI included.
  const agent = opts.agent || detectAgent() || (opts.dryRun ? "claude" : null);
  if (!agent) throw new Error("no agent CLI found on PATH - install claude, codex or gemini, or pass --agent");
  if (!AGENTS[agent]) throw new Error(`unknown agent "${agent}" - expected claude, codex or gemini`);
  if (!opts.dryRun && !which(AGENTS[agent].bin)) throw new Error(`"${AGENTS[agent].bin}" is not on PATH`);

  process.stdout.write(`\n[1/5] preparing\n`);
  const context = JSON.parse(node("prepare-review.mjs", [...(opts.target ? [opts.target] : []), "--json"]));
  const runDir = context.outDir;
  const promptDir = path.join(runDir, "prompts");
  const logDir = path.join(runDir, "logs");
  fs.mkdirSync(promptDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  process.stdout.write(
    `      ${context.stats.files} files, +${context.stats.added}/-${context.stats.deleted}, ` +
      `${context.commitCount} commits, ${context.primaryLanguage || "no language detected"}\n` +
      `      run dir ${runDir}\n`
  );

  const selected = opts.angles
    ? ANGLES.angles.filter((a) => opts.angles.includes(a.id))
    : ANGLES.angles.filter((a) => a.efforts.includes(opts.effort));
  if (selected.length === 0) throw new Error("no angles selected");

  const missing = opts.angles ? opts.angles.filter((id) => !ANGLES.angles.some((a) => a.id === id)) : [];
  if (missing.length) throw new Error(`unknown angle(s): ${missing.join(", ")}`);

  // An angle with nothing to look at returns noise, not silence.
  const dropped = [];
  const finders = selected.filter((angle) => {
    if (angle.needsGoverningDocs && context.governingDocs.repo.length === 0 && !context.governingDocs.user) {
      dropped.push(`${angle.id} (no governing docs in this repo)`);
      return false;
    }
    return true;
  });

  const finderTasks = finders.map((angle) => {
    const promptFile = path.join(promptDir, `${angle.id}.md`);
    fs.writeFileSync(promptFile, buildFinderPrompt(angle, context, opts), "utf8");
    return {
      label: angle.id,
      promptRel: path.relative(context.worktree, promptFile).split(path.sep).join("/"),
      agent,
      model: opts.model,
      cwd: context.worktree,
      logFile: path.join(logDir, `${angle.id}.log`),
    };
  });

  process.stdout.write(
    `\n[2/5] ${finderTasks.length} finder angles via ${agent}, ${Math.min(opts.concurrency, finderTasks.length)} at a time\n` +
      `      ${finderTasks.map((t) => t.label).join(", ")}\n` +
      (dropped.length ? `      dropped: ${dropped.join(", ")}\n` : "")
  );

  if (opts.dryRun) {
    process.stdout.write(`\n      dry run - prompts written to ${promptDir}, nothing spawned\n\n`);
    return;
  }

  const finderResults = await runPool(finderTasks, opts.concurrency, (r, done, total) => {
    process.stdout.write(`      [${done}/${total}] ${r.label} ${r.ok ? "ok" : `FAILED (${r.error || `exit ${r.code}`})`} ${r.seconds}s\n`);
  });

  // An agent can exit 0 and still write nothing. The findings file is the
  // contract, so check for the file rather than trusting the exit code.
  const silent = finderTasks
    .filter((t) => !fs.existsSync(path.join(context.paths.findings, `${t.label}.json`)))
    .map((t) => t.label);

  process.stdout.write(`\n[3/5] collecting\n`);
  process.stdout.write(node("collect-findings.mjs", ["collect", runDir]).replace(/^/gm, "      "));

  const clustersFile = path.join(runDir, "clusters.json");
  const { batches, clusters } = JSON.parse(fs.readFileSync(clustersFile, "utf8"));

  if (clusters.length === 0 || !opts.verify) {
    process.stdout.write(`\n[4/5] verify skipped${clusters.length === 0 ? " (no candidates)" : " (--no-verify)"}\n`);
  } else {
    const verifierTasks = batches.map((batch) => {
      const promptFile = path.join(promptDir, `verify-${batch.id}.md`);
      fs.writeFileSync(promptFile, buildVerifierPrompt(batch, context), "utf8");
      return {
        label: `verify-${batch.id}`,
        promptRel: path.relative(context.worktree, promptFile).split(path.sep).join("/"),
        agent,
        model: opts.model,
        cwd: context.worktree,
        logFile: path.join(logDir, `verify-${batch.id}.log`),
      };
    });
    process.stdout.write(`\n[4/5] ${verifierTasks.length} verify batches\n`);
    await runPool(verifierTasks, opts.concurrency, (r, done, total) => {
      process.stdout.write(`      [${done}/${total}] ${r.label} ${r.ok ? "ok" : `FAILED (${r.error || `exit ${r.code}`})`} ${r.seconds}s\n`);
    });
  }

  process.stdout.write(`\n[5/5] finalising\n`);
  process.stdout.write(node("collect-findings.mjs", ["finalize", runDir]).replace(/^/gm, "      "));

  if (silent.length) {
    process.stdout.write(
      `\n      WARNING: these angles produced no findings file and were not counted: ${silent.join(", ")}\n` +
        `      Their logs are in ${logDir}\n`
    );
  }
  const failed = finderResults.filter((r) => !r.ok).map((r) => r.label);
  if (failed.length) process.stdout.write(`      WARNING: non-zero exit from: ${failed.join(", ")}\n`);

  process.stdout.write(`\n${fs.readFileSync(path.join(runDir, "report.md"), "utf8")}\n`);
}

main().catch((error) => {
  process.stderr.write(`run-review: ${error.message}\n`);
  process.exitCode = 1;
});
