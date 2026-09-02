#!/usr/bin/env node
// run-tests.mjs — find the test files, then hand them to node --test.
//
// `node --test "scripts/test/**/*.test.mjs"` only works from Node 21 onwards;
// on Node 20 the glob is taken literally and the run fails with "Could not
// find". `node --test <dir>` is no better - its meaning has changed across
// releases. Discovering the files here and passing them explicitly is the one
// form every supported version agrees on, and it keeps adding a test file to
// a matter of dropping it in the directory.
//
//   node scripts/run-tests.mjs [dir]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || path.join(HERE, "test"));

function collect(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collect(full));
    else if (/\.test\.mjs$/.test(entry.name)) found.push(full);
  }
  // readdir order is filesystem order, not sorted, and an unstable test order
  // makes a flaky failure harder to reproduce than it needs to be.
  return found.sort();
}

if (!fs.existsSync(root)) {
  process.stderr.write(`run-tests: no such directory: ${root}\n`);
  process.exitCode = 1;
} else {
  const files = collect(root);
  if (files.length === 0) {
    process.stderr.write(`run-tests: no *.test.mjs under ${root}\n`);
    process.exitCode = 1;
  } else {
    const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
    process.exitCode = res.status === null ? 1 : res.status;
  }
}
