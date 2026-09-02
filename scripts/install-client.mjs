#!/usr/bin/env node
// install-client.mjs — put the client-specific entry points where each agent
// looks for them.
//
// The reviewing logic is client-independent: the angle definitions, the two
// deterministic scripts, and the portable orchestrator work anywhere Node runs.
// What differs is only how each client is told the capability exists - a
// Claude Code plugin, a Codex skill, an Antigravity workflow. Those adapters
// live in clients/ and are copied into place here, with the checkout path
// substituted so the installed copy can find this repository again.
//
//   node scripts/install-client.mjs codex
//   node scripts/install-client.mjs antigravity --workspace ../my-project
//   node scripts/install-client.mjs --list

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const HOME = os.homedir();

// Forward slashes in the substituted path: it is pasted into shell commands
// inside markdown, and a Windows backslash there is an escape character in
// every shell that is not cmd.exe.
const ROOT_FOR_COMMANDS = ROOT.split(path.sep).join("/");

const TARGETS = {
  codex: {
    label: "Codex CLI",
    global: () => path.join(HOME, ".codex", "skills", "deep-review"),
    workspace: null,
    source: path.join(ROOT, "clients", "codex", "skills", "deep-review"),
    verify: () => fs.existsSync(path.join(HOME, ".codex")),
    verifyHint: "~/.codex does not exist - run codex once first so it creates its home directory",
    after: [
      "Codex discovers skills in ~/.codex/skills on start.",
      'Invoke it with "$deep-review" or just ask for a deep review.',
    ],
  },
  githook: {
    label: "pre-push hook",
    // Hooks are per-repository by definition, so there is no global form.
    global: null,
    workspace: (dir) => path.join(dir, ".git", "hooks", "pre-push"),
    source: path.join(ROOT, "clients", "githook", "pre-push"),
    executable: true,
    verify: () => true,
    after: [
      "Warns on a push whose commits no review has covered. It never runs a",
      "review itself - that would spawn a dozen model sessions behind a push.",
      "DEEP_REVIEW_REQUIRE=1 turns the warning into a hard gate.",
      "DEEP_REVIEW_SKIP=1 silences it for one push.",
    ],
  },
  antigravity: {
    label: "Google Antigravity",
    // Antigravity keeps global workflows under its Gemini home; workspace
    // workflows live in .agents/ (it also still reads the older .agent/).
    global: () => path.join(HOME, ".gemini", "antigravity", "global_workflows", "deep-review.md"),
    workspace: (dir) => path.join(dir, ".agents", "workflows", "deep-review.md"),
    source: path.join(ROOT, "clients", "antigravity", "workflows", "deep-review.md"),
    verify: () => true,
    after: [
      "Invoke it in Agent with the slash command /deep-review.",
      "Antigravity caps a workflow file at 12,000 characters; this one is well under.",
    ],
  },
};

function parseArgs(argv) {
  const opts = { target: null, workspace: null, global: false, force: false, dryRun: false, list: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === "--workspace") opts.workspace = next();
    else if (arg === "--global") opts.global = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--list") opts.list = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (!arg.startsWith("-") && opts.target === null) opts.target = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const USAGE = `Usage: node install-client.mjs <client> [options]

  codex          install the skill into ~/.codex/skills/
  antigravity    install the workflow globally, or into a workspace
  githook        install a pre-push hook into one repository

  --workspace <dir>  install into that project instead of globally
  --global           force the global location (the default)
  --force            replace a pre-push hook this tool did not write
  --dry-run          print what would be written, write nothing
  --list             show every client and where its files would go

Claude Code installs differently - it takes this repository directly:

  claude plugin marketplace add ${ROOT_FOR_COMMANDS}
  claude plugin install deep-review@deep-review
`;

function render(text) {
  return text.split("{{DEEP_REVIEW_ROOT}}").join(ROOT_FOR_COMMANDS);
}

function copyRendered(from, to, dryRun) {
  const written = [];
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(from)) {
      written.push(...copyRendered(path.join(from, entry), path.join(to, entry), dryRun));
    }
    return written;
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const isText = /\.(md|yaml|yml|json|txt)$/i.test(from);
    fs.writeFileSync(to, isText ? render(fs.readFileSync(from, "utf8")) : fs.readFileSync(from));
  }
  written.push(to);
  return written;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.list) {
    for (const [name, target] of Object.entries(TARGETS)) {
      process.stdout.write(`${name}  (${target.label})\n`);
      process.stdout.write(`  global:    ${target.global ? target.global() : "not supported - per repository"}\n`);
      process.stdout.write(`  workspace: ${target.workspace ? target.workspace("<dir>") : "not supported"}\n`);
    }
    process.stdout.write(`claude  (Claude Code)\n  installed as a plugin, see --help\n`);
    return;
  }

  if (opts.help || !opts.target) {
    process.stdout.write(USAGE);
    return;
  }

  if (opts.target === "claude") {
    process.stdout.write(
      `Claude Code takes this repository as a plugin marketplace:\n\n` +
        `  claude plugin marketplace add ${ROOT_FOR_COMMANDS}\n` +
        `  claude plugin install deep-review@deep-review\n\n` +
        `Then use /deep-review. Nothing to copy.\n`
    );
    return;
  }

  const target = TARGETS[opts.target];
  if (!target) throw new Error(`unknown client "${opts.target}" - expected ${Object.keys(TARGETS).join(", ")} or claude`);

  if (opts.workspace && !target.workspace) {
    throw new Error(`${target.label} has no per-workspace location; install it globally`);
  }
  if (opts.workspace && !fs.existsSync(opts.workspace)) {
    throw new Error(`workspace directory does not exist: ${opts.workspace}`);
  }
  if (!opts.workspace && target.verify && !target.verify()) {
    throw new Error(target.verifyHint || `${target.label} does not look installed`);
  }

  // A hook has no global form, so it installs into the current repository when
  // no workspace was named.
  const workspace = opts.workspace || (target.global === null ? process.cwd() : null);
  if (target.global === null && !workspace) {
    throw new Error(`${target.label} is per-repository; pass --workspace <dir>`);
  }
  const destination = workspace ? target.workspace(path.resolve(workspace)) : target.global();

  if (workspace && target.workspace === TARGETS.githook.workspace && !fs.existsSync(path.join(path.resolve(workspace), ".git"))) {
    throw new Error(`not a git repository: ${path.resolve(workspace)}`);
  }

  const existed = fs.existsSync(destination);
  // Overwriting somebody else's hook loses work silently. Ours is recognisable
  // by its own marker; anything else needs an explicit --force.
  if (existed && target.executable && !opts.force) {
    const current = fs.readFileSync(destination, "utf8");
    if (!current.includes("deep-review pre-push hook")) {
      throw new Error(
        `${destination} already exists and was not written by deep-review. ` +
          `Merge it by hand, or pass --force to replace it.`
      );
    }
  }

  const written = copyRendered(target.source, destination, opts.dryRun);
  if (target.executable && !opts.dryRun) {
    for (const file of written) fs.chmodSync(file, 0o755);
  }

  process.stdout.write(
    `${opts.dryRun ? "would install" : existed ? "reinstalled" : "installed"} ${target.label}\n` +
      written.map((file) => `  ${file}\n`).join("") +
      `\n  checkout referenced as ${ROOT_FOR_COMMANDS}\n` +
      (target.after ? `\n${target.after.map((line) => `  ${line}\n`).join("")}` : "")
  );
  if (!opts.dryRun) {
    process.stdout.write(
      `\n  Note: the installed copy points back at this checkout. If you move or\n` +
        `  delete it, run this installer again from the new location.\n`
    );
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`install-client: ${error.message}\n`);
  process.exitCode = 1;
}
