#!/usr/bin/env node
// prepare-review.mjs — the deterministic front half of a deep review.
//
// Everything in here is decided by a script rather than by a model: which
// commits are in scope, which files changed, which languages the diff touches,
// which governing docs (CLAUDE.md / AGENTS.md) sit above the changed files.
// The finder agents are expensive; none of their tokens should be spent
// rediscovering facts that `git` already knows.
//
// Writes a run directory (default .deep-review/<run-id>/) containing:
//   full.diff     unified diff, everything
//   code.diff     the same minus docs, lockfiles and generated artefacts
//   context.md    the shared "run context" block pasted into every agent prompt
//   context.json  the same, machine-readable
//   findings/     empty; each finder agent drops <angle>.json here
//   verdicts/     empty; each verifier agent drops <batch>.json here

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ASCII unit separator, spelled by code point so no raw control character ever
// has to survive a copy-paste through a shell, a diff viewer, or a chat client.
const UNIT_SEP = String.fromCharCode(31);

// ---------------------------------------------------------------- git helpers

function git(args, { cwd = process.cwd(), allowFail = false, raw = false } = {}) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed (${res.status}):\n${res.stderr}`);
  }
  // NUL-delimited output must not be trimmed: the delimiters are the structure.
  const stdout = res.stdout || "";
  return { ok: res.status === 0, out: raw ? stdout : stdout.trim(), err: (res.stderr || "").trim() };
}

// `git diff --numstat` prints a rename as a single field - "src/{a.mjs =>
// b.mjs}" for a move within a directory, "src/a.mjs => b.mjs" across one - so
// splitting on tabs yields a path that exists nowhere and that no angle can
// open. With -z the path field is empty and the old and new names follow as
// their own NUL-terminated fields, which is unambiguous.
function parseNumstat(raw) {
  const fields = raw.split("\0");
  const files = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!field) continue;
    const firstTab = field.indexOf("\t");
    const secondTab = field.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;

    const addedRaw = field.slice(0, firstTab);
    const deletedRaw = field.slice(firstTab + 1, secondTab);
    let filePath = field.slice(secondTab + 1);
    let renamedFrom = null;
    if (filePath === "") {
      renamedFrom = fields[i + 1];
      filePath = fields[i + 2];
      i += 2;
    }
    if (!filePath) continue;

    // git prints "-" for both counts on binary files; Number("-") is NaN,
    // which would poison every downstream sum.
    const added = addedRaw === "-" ? 0 : Number(addedRaw);
    const deleted = deletedRaw === "-" ? 0 : Number(deletedRaw);
    files.push({
      path: filePath.replace(/\\/g, "/"),
      added,
      deleted,
      changed: added + deleted,
      binary: addedRaw === "-",
      ...(renamedFrom ? { renamedFrom: renamedFrom.replace(/\\/g, "/") } : {}),
    });
  }
  return files;
}

// Returning a bare null collapsed five different failures - gh not installed,
// not authenticated, no GitHub remote, unknown PR, rate limited - into one
// message about authentication. gh already says which it was; forward it.
// No shell: the sibling orchestrator refuses the args-array-plus-shell form
// (DEP0190, unescaped concatenation) and these two should not disagree.
function gh(args, { cwd = process.cwd() } = {}) {
  const res = spawnSync("gh", args, { cwd, encoding: "utf8" });
  if (res.error) {
    return { ok: false, detail: res.error.code === "ENOENT" ? "gh is not installed or not on PATH" : res.error.message };
  }
  if (res.status !== 0) return { ok: false, detail: (res.stderr || "").trim() || `gh exited ${res.status}` };
  return { ok: true, out: (res.stdout || "").trim() };
}

// ------------------------------------------------------------------ arg parse

function parseArgs(argv) {
  const opts = { target: null, out: null, json: false, maxDiffMb: 8, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // A flag that swallows the following token is the classic argv bug: when the
    // value is missing it eats the next flag instead of complaining. Refuse.
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === "--target") opts.target = next();
    else if (arg === "--out") opts.out = next();
    else if (arg === "--max-diff-mb") {
      // NaN would make every `megabytes > limit` comparison false, silently
      // removing the guard rather than enforcing a different one.
      const value = Number(next());
      if (!Number.isFinite(value) || value <= 0) throw new Error("--max-diff-mb must be a positive number");
      opts.maxDiffMb = value;
    }
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (!arg.startsWith("-") && opts.target === null) opts.target = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const USAGE = `Usage: node prepare-review.mjs [target] [options]

Target forms (default: "working"):
  working          uncommitted changes plus commits since the merge-base with the default branch
  branch           the current branch vs its merge-base with the default branch
  <ref>            any ref, or a range "<base>..<head>"
  <number>         a GitHub PR number (requires gh)
  pr:<number>      the same, explicit

Options:
  --out <dir>        run directory (default .deep-review/<timestamp>)
  --max-diff-mb <n>  refuse to prepare a diff larger than this (default 8)
  --json             print the context as JSON instead of a human summary
`;

// ------------------------------------------------------------ target to range

// Ask git which branch the remote considers primary before falling back to a
// guess. A repo whose default branch is neither main nor master is common
// enough that guessing first would silently review the wrong range.
function defaultBranch(cwd) {
  const symbolic = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd, allowFail: true });
  if (symbolic.ok && symbolic.out) return symbolic.out.replace("refs/remotes/", "");
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", candidate], { cwd, allowFail: true }).ok) return candidate;
  }
  return null;
}

function resolveTarget(rawTarget, cwd) {
  const target = rawTarget || "working";

  const prMatch = /^(?:pr:)?#?(\d+)$/.exec(target);
  if (prMatch) {
    const number = prMatch[1];
    const result = gh(["pr", "view", number, "--json", "baseRefName,headRefName,headRefOid,title,url"], { cwd });
    if (!result.ok) {
      throw new Error(
        `could not read PR #${number} via gh: ${result.detail}\n` +
          `Pass an explicit range instead, such as "origin/main..HEAD".`
      );
    }
    const pr = JSON.parse(result.out);
    // Fetch so the head commits exist locally even when the PR came from a fork.
    git(["fetch", "origin", `pull/${number}/head`, pr.baseRefName], { cwd, allowFail: true });
    const headRef = git(["rev-parse", "--verify", "--quiet", pr.headRefOid], { cwd, allowFail: true }).ok
      ? pr.headRefOid
      : "FETCH_HEAD";
    return {
      kind: "pr",
      label: `PR #${number} - ${pr.title}`,
      url: pr.url,
      prNumber: number,
      baseRef: `origin/${pr.baseRefName}`,
      headRef,
      includeWorkingTree: false,
    };
  }

  if (target === "working" || target === "branch") {
    const base = defaultBranch(cwd);
    if (!base) throw new Error("no default branch found; pass an explicit range such as origin/main..HEAD");
    const head = git(["rev-parse", "HEAD"], { cwd }).out;
    const branchName = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd, allowFail: true }).out || "HEAD";
    return {
      kind: target,
      label: target === "working" ? `working tree on ${branchName}` : `branch ${branchName}`,
      baseRef: base,
      headRef: head,
      // "working" is the only target that folds in what has not been committed
      // yet - which is the whole point of reviewing before you commit.
      includeWorkingTree: target === "working",
    };
  }

  if (target.includes("..")) {
    const [base, head] = target.split(/\.{2,3}/);
    return { kind: "range", label: target, baseRef: base, headRef: head || "HEAD", includeWorkingTree: false };
  }

  if (!git(["rev-parse", "--verify", "--quiet", target], { cwd, allowFail: true }).ok) {
    throw new Error(`"${target}" is not a ref, a range, or a PR number`);
  }
  const base = defaultBranch(cwd);
  return { kind: "ref", label: target, baseRef: base || `${target}^`, headRef: target, includeWorkingTree: false };
}

// -------------------------------------------------------------- diff assembly

// Docs, lockfiles and generated output dominate a diff by line count and carry
// almost no reviewable logic. code.diff is what the finder angles read first;
// full.diff stays available for the angles that review prose (conventions,
// removed-behavior, altitude).
//
// One definition, two consumers: git pathspecs for tracked files and a
// predicate for the untracked ones git will not diff. Keeping them as two
// hand-written lists diverged within a day - *.min.js was in the pathspecs and
// missing from the predicate - so the same file was noise or not depending on
// whether git had been told about it.
const NOISE_SUFFIXES = ["md", "mdx", "lock", "snap", "map", "min.js"];
const NOISE_FILENAMES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
];
const NOISE_DIRECTORIES = ["dist", "build", "vendor", "node_modules", "__snapshots__"];

// `**/dir/**` matches a nested dist/ but NOT one at the repository root, so the
// root-anchored form has to be listed alongside it - verified against git
// rather than assumed. Without it the biggest generated directory in a typical
// project is the one that survives into the diff.
const NOISE_PATHSPECS = [
  ...NOISE_SUFFIXES.map((suffix) => `:(exclude)*.${suffix}`),
  ...NOISE_FILENAMES.flatMap((name) => [`:(exclude)${name}`, `:(exclude)**/${name}`]),
  ...NOISE_DIRECTORIES.flatMap((dir) => [`:(exclude)${dir}/**`, `:(exclude)**/${dir}/**`]),
];

function isNoise(relPath) {
  const posix = relPath.replace(/\\/g, "/");
  const base = posix.slice(posix.lastIndexOf("/") + 1);
  if (NOISE_SUFFIXES.some((suffix) => base.toLowerCase().endsWith(`.${suffix}`))) return true;
  if (NOISE_FILENAMES.includes(base)) return true;
  return posix.split("/").slice(0, -1).some((segment) => NOISE_DIRECTORIES.includes(segment));
}

// -U12 rather than the default -U3: every angle is told to reason about the
// enclosing function, and wide context means fewer follow-up file reads.
function diffArgs(range, { codeOnly, includeWorkingTree }) {
  const args = ["diff", "--no-color", "-M", "-U12"];
  args.push(includeWorkingTree ? range.mergeBase : `${range.mergeBase}..${range.headSha}`);
  args.push("--");
  if (codeOnly) args.push(...NOISE_PATHSPECS);
  return args;
}

// `git diff` never shows a file git has not been told about, so a brand-new
// file in an uncommitted change would be reviewed as if it did not exist -
// exactly the file that most needs reviewing. Synthesise its diff instead of
// touching the index: `git add -N` would mutate the user's staging area, and a
// review must not.
// -z for two reasons. Without it git C-quotes any path containing a non-ASCII
// byte or a quote, and the quoted spelling then fails `git diff --no-index`, so
// the file is dropped from the review with no message at all. It also removes
// the newline-in-a-filename hazard.
//
// The run directory is excluded explicitly: this tool writes it, and in a repo
// that has not gitignored .deep-review/ every later review would fold the
// previous review's diffs, findings and logs in as new source to review.
function untrackedFiles(root) {
  const out = git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, allowFail: true, raw: true }).out;
  return out
    .split("\0")
    .filter(Boolean)
    .filter((relPath) => !relPath.split("/")[0].startsWith(".deep-review"));
}

function untrackedDiff(root, relPath) {
  const res = spawnSync("git", ["diff", "--no-color", "--no-index", "-U12", "--", "/dev/null", relPath], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // --no-index exits 1 when the files differ, which is the normal case here.
  if (res.error || (res.status !== 0 && res.status !== 1) || !res.stdout) return null;
  const posix = relPath.replace(/\\/g, "/");
  // The header carries whatever path spelling was passed, absolute on Windows.
  // Rewrite it so every consumer sees one repo-relative path.
  return res.stdout
    .replace(/^diff --git a\/.*? b\/.*$/m, `diff --git a/${posix} b/${posix}`)
    .replace(/^\+\+\+ b\/.*$/m, `+++ b/${posix}`);
}


const LANGUAGE_BY_EXT = new Map(Object.entries({
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescript",
  ".py": "python", ".pyi": "python",
  ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp",
  ".swift": "swift",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell",
  ".ps1": "powershell",
  ".sql": "sql",
  ".yml": "config", ".yaml": "config", ".json": "config", ".toml": "config", ".xml": "config",
}));

function detectLanguages(files) {
  const counts = new Map();
  for (const file of files) {
    const lang = LANGUAGE_BY_EXT.get(path.extname(file.path).toLowerCase());
    if (!lang || lang === "config") continue;
    counts.set(lang, (counts.get(lang) || 0) + file.changed);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([lang, changed]) => ({ lang, changed }));
}

// A CLAUDE.md two directories above a changed file governs that file. Walking
// up from every changed path finds the ones that actually apply, instead of
// only the repo root.
function governingDocs(root, files) {
  const names = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];
  const found = new Set();
  const normalizedRoot = path.resolve(root);
  for (const file of files) {
    let dir = path.dirname(path.resolve(normalizedRoot, file.path));
    for (;;) {
      for (const name of names) {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) {
          found.add(path.relative(normalizedRoot, candidate).split(path.sep).join("/"));
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir || dir === normalizedRoot) break;
      dir = parent;
    }
  }
  const userLevel = path.join(os.homedir(), ".claude", "CLAUDE.md");
  return { repo: [...found].sort(), user: fs.existsSync(userLevel) ? userLevel : null };
}

// ------------------------------------------------------------------------ main

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  const root = git(["rev-parse", "--show-toplevel"]).out;
  const target = resolveTarget(opts.target, root);

  const headSha = git(["rev-parse", target.headRef], { cwd: root }).out;
  const baseSha = git(["rev-parse", target.baseRef], { cwd: root }).out;
  const mergeBase = git(["merge-base", baseSha, headSha], { cwd: root, allowFail: true }).out || baseSha;
  const range = { mergeBase, headSha, baseSha };

  const commits = git(
    ["log", `--format=%H${UNIT_SEP}%s${UNIT_SEP}%an`, `${mergeBase}..${headSha}`],
    { cwd: root, allowFail: true }
  ).out;
  const commitList = commits
    ? commits.split("\n").map((line) => {
        const [sha, subject, author] = line.split(UNIT_SEP);
        return { sha, subject, author };
      })
    : [];

  const numstat = git(
    ["diff", "--numstat", "-M", "-z", target.includeWorkingTree ? mergeBase : `${mergeBase}..${headSha}`],
    { cwd: root, raw: true }
  ).out;
  const files = parseNumstat(numstat);

  const untracked = [];
  if (target.includeWorkingTree) {
    for (const relPath of untrackedFiles(root)) {
      const patch = untrackedDiff(root, relPath);
      if (!patch) continue;
      const added = (patch.match(/^\+/gm) || []).length - 1; // minus the +++ header line
      untracked.push({ path: relPath.replace(/\\/g, "/"), patch, added: Math.max(added, 0) });
      files.push({
        path: relPath.replace(/\\/g, "/"),
        added: Math.max(added, 0),
        deleted: 0,
        changed: Math.max(added, 0),
        binary: false,
        untracked: true,
      });
    }
  }

  if (files.length === 0) {
    const headLabel = target.includeWorkingTree ? "working tree" : headSha.slice(0, 8);
    throw new Error(`nothing to review: ${mergeBase.slice(0, 8)}..${headLabel} is empty`);
  }

  const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const outDir = path.resolve(opts.out || path.join(root, ".deep-review", runId));
  fs.mkdirSync(path.join(outDir, "findings"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "verdicts"), { recursive: true });

  const trackedFull = git(diffArgs(range, { codeOnly: false, includeWorkingTree: target.includeWorkingTree }), { cwd: root }).out;
  const trackedCode = git(diffArgs(range, { codeOnly: true, includeWorkingTree: target.includeWorkingTree }), { cwd: root }).out;
  const untrackedFull = untracked.map((u) => u.patch).join("");
  const untrackedCode = untracked.filter((u) => !isNoise(u.path)).map((u) => u.patch).join("");
  const fullDiff = [trackedFull, untrackedFull].filter(Boolean).join("\n");
  const codeDiff = [trackedCode, untrackedCode].filter(Boolean).join("\n");

  const megabytes = Buffer.byteLength(fullDiff, "utf8") / (1024 * 1024);
  if (megabytes > opts.maxDiffMb) {
    throw new Error(
      `diff is ${megabytes.toFixed(1)} MB, over the ${opts.maxDiffMb} MB limit. Narrow the target, or raise --max-diff-mb deliberately.`
    );
  }

  const fullDiffPath = path.join(outDir, "full.diff");
  const codeDiffPath = path.join(outDir, "code.diff");
  fs.writeFileSync(fullDiffPath, fullDiff ? `${fullDiff}\n` : "", "utf8");
  fs.writeFileSync(codeDiffPath, codeDiff ? `${codeDiff}\n` : "", "utf8");

  const languages = detectLanguages(files);
  const docs = governingDocs(root, files);

  const context = {
    runId,
    outDir,
    worktree: root,
    target,
    baseRef: target.baseRef,
    baseSha,
    headSha,
    mergeBase,
    includesWorkingTree: target.includeWorkingTree,
    commitCount: commitList.length,
    commits: commitList,
    files,
    stats: {
      files: files.length,
      added: files.reduce((sum, f) => sum + f.added, 0),
      deleted: files.reduce((sum, f) => sum + f.deleted, 0),
      codeDiffBytes: Buffer.byteLength(codeDiff, "utf8"),
      fullDiffBytes: Buffer.byteLength(fullDiff, "utf8"),
    },
    languages,
    primaryLanguage: languages.length > 0 ? languages[0].lang : null,
    governingDocs: docs,
    paths: {
      fullDiff: fullDiffPath,
      codeDiff: codeDiffPath,
      findings: path.join(outDir, "findings"),
      verdicts: path.join(outDir, "verdicts"),
    },
  };

  fs.writeFileSync(path.join(outDir, "context.json"), `${JSON.stringify(context, null, 2)}\n`, "utf8");

  const topFiles = [...files].sort((a, b) => b.changed - a.changed).slice(0, 25);
  const more = files.length > topFiles.length
    ? `\n- ...and ${files.length - topFiles.length} more (see context.json)`
    : "";
  const contextMd = `# Run context

- **Target**: ${target.label}${target.url ? ` (${target.url})` : ""}
- **Worktree**: ${root} - run every command from this directory, do not cd to another checkout.
- **Base**: ${target.baseRef} = ${baseSha}
- **Head**: ${headSha}${target.includeWorkingTree ? " plus uncommitted working-tree changes" : ""}
- **Merge base**: ${mergeBase}
- **Commits**: ${commitList.length}
- **Scope**: ${context.stats.files} files, +${context.stats.added}/-${context.stats.deleted}
- **Languages**: ${languages.length ? languages.map((l) => l.lang).join(", ") : "none detected"}
- **Governing docs**: ${docs.repo.length ? docs.repo.join(", ") : "none in-repo"}${docs.user ? `; user-level ${docs.user}` : ""}

## Diffs

- \`${codeDiffPath}\` - code only, docs and lockfiles excluded. **Start here.**
- \`${fullDiffPath}\` - the same plus docs and config.

Read them with the Read tool. Use Read/Grep/Glob and Bash freely to open the
enclosing function of every hunk, follow callers, and run small experiments.
**Do not modify any file and do not commit.**

## Changed files (largest first)

${topFiles.map((f) => `- \`${f.path}\` +${f.added}/-${f.deleted}`).join("\n")}${more}

## Commits

${commitList.length ? commitList.map((c) => `- \`${c.sha.slice(0, 8)}\` ${c.subject}`).join("\n") : "- (none - uncommitted work only)"}
`;
  fs.writeFileSync(path.join(outDir, "context.md"), contextMd, "utf8");

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
    return;
  }

  const headLabel = target.includeWorkingTree ? "working tree" : headSha.slice(0, 8);
  process.stdout.write(
    [
      `run id      ${runId}`,
      `run dir     ${outDir}`,
      `target      ${target.label}`,
      `range       ${mergeBase.slice(0, 8)}..${headLabel} (${commitList.length} commits)`,
      `scope       ${context.stats.files} files, +${context.stats.added}/-${context.stats.deleted}`,
      `languages   ${languages.length ? languages.map((l) => `${l.lang} (${l.changed})`).join(", ") : "none detected"}`,
      `docs        ${docs.repo.length ? docs.repo.join(", ") : "none"}`,
      `context     ${path.join(outDir, "context.md")}`,
      "",
    ].join("\n")
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`prepare-review: ${error.message}\n`);
  process.exitCode = 1;
}
