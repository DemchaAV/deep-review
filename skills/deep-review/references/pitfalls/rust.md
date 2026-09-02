# Pitfall catalogue: Rust

## Correctness

- **`unwrap` / `expect` on a value that can fail at runtime** - every one is a
  claimed invariant. Ask what makes it hold. In a library, it is a panic in
  someone else's process.
- **`unwrap` on a lock** - a poisoned mutex panics the caller too, turning one
  thread's bug into a cascade.
- **Integer overflow** panics in debug and wraps in release. Arithmetic on
  sizes, indices and timestamps needs `checked_`, `saturating_` or
  `wrapping_` spelled explicitly.
- **`as` casts** truncate silently - `u64 as u32`, `usize as i32`, `f64 as u8`.
  `try_into()` is the checked form.
- **Indexing with `[]`** panics; `get()` returns an `Option`.
- **`unsafe` blocks** - state the invariant each one relies on and check the
  surrounding code upholds it. An `unsafe` without a safety comment is a
  finding in most codebases.
- **Shadowing that changes the type** of a binding mid-function, so a later
  line operates on something other than what it reads like.

## Ownership and lifetimes

- **`clone()` added to silence the borrow checker** in a hot path - correct but
  possibly expensive; note it for the efficiency angle.
- **`Rc<RefCell<T>>` cycles** leak; `RefCell` borrow conflicts panic at runtime,
  not compile time.
- **A `MutexGuard` held across an `.await`** deadlocks or blocks the executor;
  it also makes the future non-`Send`.
- **`std::mem::take` / `replace` leaving a default** where the caller expects
  the original.

## Errors

- **`?` converting an error into a type that loses context** - check the `From`
  impl.
- **A custom error enum with a catch-all variant** that swallows the
  distinction the caller needed.
- **`Result` ignored** with `let _ =` on something that can genuinely fail.

## Async

- **A future created but never awaited** does nothing - Rust futures are lazy.
- **Blocking I/O inside an async task** stalls the executor;
  `spawn_blocking` exists for that.
- **`tokio::select!` cancelling a branch mid-operation** - any state that
  branch mutated is now half-updated.
- **A spawned task whose `JoinHandle` is dropped** - the task runs but its
  panic is invisible.

## Traits, generics, API

- **A trait method added to a public trait** is a breaking change for external
  implementors unless it has a default body.
- **`Default` derived on a type where the zero value is not valid.**
- **`PartialEq` / `Hash` derived over a field that should not participate** in
  identity - or a manual `Hash` inconsistent with `Eq`.
- **`impl Trait` in return position** narrowing what callers can do with the
  value.

## Build and tests

- **A feature flag gating code that another module uses unconditionally** -
  compiles locally with default features, fails in a consumer's build.
- **`#[cfg(test)]` helpers** relied on by a benchmark or an integration test,
  which do not see them.
- **`dev-dependencies` used in non-test code.**
- **Tests that depend on `HashMap` iteration order.**
