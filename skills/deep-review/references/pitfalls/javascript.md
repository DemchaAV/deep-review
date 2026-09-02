# Pitfall catalogue: JavaScript / Node.js

Applies to `.js`, `.mjs`, `.cjs`, `.jsx`. For TypeScript, read this **and**
`typescript.md`.

## Language traps

- **Falsy-zero and empty-string.** `if (!x)`, `x || fallback`, `x ? a : b`
  where `0`, `""`, `false` or `NaN` is a legitimate value. `??` and `?.` are
  the fix; check whether the diff used `||` where it meant `??`.
- **Optional chaining hiding a real bug.** `a?.b.c` still throws if `b` is
  null; `a?.b?.c` returning `undefined` may be silently swallowing a
  precondition failure that should have thrown.
- **`==` coercion**, especially against `null`, `0`, `""` and `[]`.
- **`Array.prototype.sort` without a comparator** sorts numbers lexically:
  `[10, 9, 1].sort()` is `[1, 10, 9]`.
- **Mutation of a shared module-level object.** A cached module, config or
  client object mutated by one caller is mutated for every caller in the
  process.
- **`{...obj, key: undefined}` leaves an own property** whose value is
  `undefined`. `"key" in obj` is true, `Object.keys` includes it, and
  `JSON.stringify` drops it - so the four ways of asking "is it there"
  disagree. Libraries that iterate own properties (schema validators,
  serialisers, ORMs) see the key.
- **`delete` vs setting undefined** - the same disagreement, opposite
  direction.
- **`Object.keys` / `Object.entries` on `null`** throws; on `undefined` too.
- **Closure-captured loop variables** with `var`, or a `let` captured by an
  async callback that runs after the loop.
- **`new RegExp` from a user string** without escaping; and
  `String.replace(".", "\\.")` with a string first argument replaces only the
  **first** occurrence.
- **Number parsing of versions.** `parseFloat("2.10") === 2.1` sorts below
  `2.9`; `"2.3.0-rc1".split(".").map(Number)` yields `NaN` in the last slot.
- **`Number("")` is 0** and `Number("-")` is `NaN` - both poison sums.

## Async

- **Missing `await`** on a call whose rejection then escapes the surrounding
  `try/catch` and becomes an unhandled rejection.
- **`forEach` with an async callback** does not wait. `for...of` or
  `Promise.all` does.
- **`await` inside a loop** where the iterations are independent - correctness
  is fine, but it is the efficiency angle's ground; note it there.
- **`process.exit()` truncates pending stdout/stderr writes.** Set
  `process.exitCode` and let the process end naturally, especially after a
  large `write`. An `exitCode` assigned *after* an `exit()` call never applies.
- **Top-level `await` in a module that tests also import** delays every
  importer, and a failure there is an unhandled rejection at import time, not a
  test failure.

## Filesystem and process

- **`fs.existsSync` then read** is a TOCTOU race and, more practically, two
  syscalls where one `try { read } catch` does the job.
- **`path.join` vs `path.resolve`** - `resolve` discards everything before an
  absolute second argument, which is either the fix or the bug depending on
  intent.
- **`fs.readdirSync` ordering** is not guaranteed to be sorted; code that
  depends on order needs an explicit sort.
- **`mtime` comparisons** across filesystems: resolution differs (1s on some),
  and copy or checkout order can make a derived file *older* than its source.
- **`spawnSync` without `shell`** cannot run a `.cmd`/`.bat` shim on Windows -
  which is how most npm-installed binaries appear there.
- **`JSON.parse` of a file** with no `try/catch`: an empty file, a truncated
  write, or a BOM all throw.

## Modules

- **`import()` of a path built by string concatenation** breaks on Windows:
  a `C:\...` path is not a valid URL. Use `pathToFileURL()`.
- **`createRequire(import.meta.url)`** resolves relative to that module's
  location - check the base path exists and is the one intended.
- **Default-export interop** between ESM `import x from "cjs-pkg"` and
  `require("cjs-pkg")` can yield `{default: fn}` instead of `fn`. The symptom is
  "x is not a function" only under one of the two loaders.
- **Relative import depth** after a file moves - count the `..` segments
  against the file's new location.

## node:test

- **An async test body whose promise is not returned or awaited** passes
  vacuously.
- **`t.test()` subtests not awaited** run after the parent reports.
- **`assert.throws` with a regex** matches against the error *message*; against
  a non-Error thrown value the behaviour is not what most people expect.
- **Tests sharing a temp directory** collide when the runner parallelises files.
- **`assert.ok(value, message)`** with a non-string message: an Error is thrown
  as-is, an object is stringified unhelpfully.

## Schema validation (Ajv 8 and similar)

- **`strict: true`** makes unknown keywords and unknown formats throw at
  compile time, not validate time - a schema that worked under a lax instance
  fails to compile under a strict one.
- **Compiling an extracted sub-schema** loses the parent's `$defs`, so any
  `$ref: "#/$defs/..."` inside it fails to resolve.
- **`errorsText()` on a null `errors`** and reading `validate.errors` after a
  *successful* validation - the property holds the previous call's errors.
- **`allErrors: false`** (the default) reports only the first error, which
  turns a multi-problem document into a one-line complaint.
- **`addFormats`** must be applied to the same instance that compiles the
  schema; a second instance silently lacks the formats.

## Windows and cross-platform

- **`path.sep`** - splitting on a literal `"/"`, or comparing a stored `/` path
  against a built `\` one.
- **Case-insensitive filesystem** - two paths differing only in case are the
  same file on Windows and macOS, and different on Linux CI.
- **CRLF** - fixtures compared byte-wise fail after a checkout with
  `core.autocrlf` set.
- **Quoting in a command the tool prints for a human to copy** - a path with a
  space, or a `$` that PowerShell expands.
- **`/dev/null`** does not exist on Windows outside a POSIX shell.
