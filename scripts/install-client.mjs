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
  const opts = { target: null, workspace: null, global: false, dryRun: false, list: false, help: false };
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

  --workspace <dir>  install into that project instead of globally
  --global           force the global location (the default)
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
      process.stdout.write(`  global:    ${target.global()}\n`);
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

  const destination = opts.workspace ? target.workspace(path.resolve(opts.workspace)) : target.global();
  const existed = fs.existsSync(destination);
  const written = copyRendered(target.source, destination, opts.dryRun);

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
