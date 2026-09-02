# Pitfall catalogue: Python

## Language traps

- **Mutable default arguments** - `def f(items=[])` shares one list across every
  call, forever.
- **Late-binding closures** - `[lambda: i for i in range(3)]` all return 2.
- **Truthiness of empty containers and zero** - `if not items` is true for
  `[]`, `{}`, `""`, `0` and `None` alike. `if items is None` is usually meant.
- **`except Exception`** swallowing `KeyboardInterrupt` is avoided by that
  spelling, but `except:` bare does not; and either can hide a typo as a
  runtime pass.
- **`==` vs `is`** on small ints and interned strings works by accident and
  fails on the value that matters.
- **Integer division `/` vs `//`**, and `-7 // 2 == -4` (floors, not
  truncates); `%` follows the divisor's sign.
- **Shadowing a builtin or a stdlib module name** with a local file -
  `types.py`, `json.py`, `logging.py` next to the code that imports them.
- **`dict` ordering is insertion order** since 3.7, but `set` ordering is not
  stable across runs with hash randomisation enabled for strings.
- **String formatting of `None`** produces `"None"` rather than failing.
- **`datetime.now()` is naive**; comparing it to an aware datetime raises.
  `utcnow()` is naive too - that is the classic bug.

## Typing and dataclasses

- **`Optional[X]` annotations that the code then dereferences** unconditionally
  - annotations are not enforced at runtime.
- **A mutable dataclass field without `field(default_factory=...)`** raises at
  class definition, but a `ClassVar` mutable does not - and is shared.
- **`__eq__` without `__hash__`** makes instances unhashable; `@dataclass`
  applies its own rules depending on `eq` and `frozen`.

## Async

- **A coroutine never awaited** - it produces a `RuntimeWarning`, not an error,
  and the work simply does not happen.
- **Blocking I/O inside an async function** stalls the whole event loop.
- **`asyncio.gather` without `return_exceptions`** cancels siblings on the first
  failure; with it, exceptions arrive as *values* the caller must inspect.
- **Creating a task without holding a reference** lets the garbage collector
  cancel it mid-flight.

## Filesystem and process

- **`open()` without an explicit `encoding`** uses the platform default -
  cp1252 on Windows, UTF-8 elsewhere - so the same file reads differently.
- **`os.path.join` with an absolute second argument** discards the first.
- **`subprocess` with `shell=True`** and an interpolated argument is a command
  injection; without it, a string command is not split as expected.
- **`os.listdir` / `glob` ordering** is filesystem order, not sorted.
- **`Path.resolve()` on a non-existent path** behaves differently across
  versions with `strict`.

## Packaging and imports

- **Relative vs absolute imports** differing between running as a module
  (`python -m pkg.mod`) and as a script (`python pkg/mod.py`).
- **A dependency imported but not declared** in `pyproject.toml` /
  `requirements.txt` - it works locally because something else pulled it in.
- **Import-time side effects** that make test collection order significant.

## pytest / unittest

- **A fixture with the wrong scope** shared across tests that mutate it.
- **`assert` in a helper module** that pytest does not rewrite, so failures
  print no useful diff.
- **`tmp_path` vs a hard-coded temp directory** shared by parallel workers.
- **Tests depending on execution order** - `pytest-randomly` or `-p no:cacheprovider`
  exposes them; CI may not.

## Cross-platform

- **Path separators** - `str(path).split("/")`, and case-insensitivity on
  Windows and macOS.
- **`os.environ` is case-insensitive on Windows** and case-sensitive elsewhere.
- **Line endings** in files opened in binary mode versus text mode.
- **`signal` handling and `os.fork`** are largely unavailable on Windows.
