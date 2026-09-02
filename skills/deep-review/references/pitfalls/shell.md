# Pitfall catalogue: Shell (bash / sh / PowerShell)

## POSIX shell and bash

- **Unquoted variable expansion.** `$var` splits on whitespace and globs.
  `"$var"` is almost always what was meant; `"$@"` never `$*`.
- **No `set -euo pipefail`** in a script whose failure should stop it - and,
  where it *is* set, remember `-e` does not fire inside a condition, a `&&`
  chain's left side, or a command whose status is tested.
- **`pipefail` absent** means a pipeline reports only the last command's
  status, so `grep x file | head` hides `grep`'s failure.
- **Command substitution swallowing exit status** - `out=$(cmd)` under `-e`
  does stop, but `echo "$(cmd)"` does not.
- **`[ ]` vs `[[ ]]`** - `[` needs quoting and does not do pattern matching;
  `==` inside `[[ ]]` globs unless the right side is quoted.
- **String comparison against an empty variable** - `[ $x = y ]` is a syntax
  error when `x` is empty and unquoted.
- **`cd` without checking**, then a destructive command running in the wrong
  directory. `cd dir || exit 1`.
- **`rm -rf "$dir/"` where `$dir` may be empty** - the canonical catastrophe.
  Check the variable is set and non-empty first.
- **Parsing `ls`** instead of globbing, and word-splitting filenames with
  spaces or newlines.
- **A `for` loop over `$(cat file)`** rather than `while read -r line`, which
  also needs `-r` to keep backslashes and `IFS=` to keep leading whitespace.
- **`trap` cleanup that runs on the error path only**, or a temp directory
  created without one.
- **Heredoc with an unquoted delimiter** expands `$` and backticks inside; a
  quoted one (`<<'EOF'`) does not. The closing delimiter must be at column 0.
- **Exit code of the wrong command** - `local x=$(cmd)` masks `cmd`'s status
  behind `local`'s.

## PowerShell

- **`-ErrorAction SilentlyContinue`** suppresses the message, not the failure -
  the exit status still reflects it. `try { ... -ErrorAction Stop } catch {}`
  is the actual swallow.
- **`$?` and `$LASTEXITCODE`** track different things: the former the last
  PowerShell operation, the latter the last native executable.
- **Native arguments beginning with `-` or `@`** are parsed by PowerShell
  before the executable sees them; `--%` stops that.
- **The pipeline carries objects, not text** - `| Select-String` on an object
  stream matches the formatted rendering, not the data.
- **`$null` on the left of a comparison** is the convention for a reason:
  `$x -eq $null` on an array filters it instead of testing it.
- **Automatic unrolling** - a single-element array assigned from a pipeline
  becomes the element, so `.Count` is not what the code expects.

## Both

- **Assuming a command exists** without checking - `jq`, `gh`, `rg`, GNU vs BSD
  `sed`/`date` flags differ across macOS, Linux and Git Bash.
- **Relative paths depending on the caller's working directory** rather than
  the script's own location.
- **Secrets on the command line** are visible in the process table and in shell
  history.
- **A script that is also sourced** and calls `exit`, killing the caller's
  shell.
