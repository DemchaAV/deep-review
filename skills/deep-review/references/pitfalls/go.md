# Pitfall catalogue: Go

## Language traps

- **Errors ignored** - `_ = f()`, or a returned error checked in one branch and
  dropped in another. Every `if err != nil` that does not wrap loses context.
- **Shadowed `err`** inside an `if` or `:=` in an inner scope, so the outer
  check tests a stale value.
- **`defer` in a loop** accumulates until function return; and a `defer`
  capturing a loop variable pre-Go 1.22 captures the last value.
- **`defer` evaluating arguments immediately** while the call runs later.
- **A nil pointer inside a non-nil interface** - a typed nil returned as
  `error` makes `err != nil` true.
- **Slice aliasing** - `append` may or may not copy; two slices sharing a
  backing array mutate each other. `s[:0]` reuse and passing a sub-slice out of
  a function both leak the parent array.
- **Map iteration order is randomised** - any output that depends on it is
  non-deterministic.
- **Writing to a nil map** panics; reading from one does not.
- **Struct comparison with `==`** panics for structs containing slices or maps.
- **Integer division and conversion truncation** - `int(f)` truncates toward
  zero, and `int32(largeInt64)` wraps silently.
- **String indexing yields bytes, not runes** - iterating a string with an
  index breaks on any multi-byte character.

## Concurrency

- **A goroutine with no way to stop** - no context, no done channel; it outlives
  the request.
- **A `WaitGroup.Add` inside the goroutine** rather than before it.
- **Unbuffered channel send with no receiver** deadlocks; a buffered one hides
  the deadlock until the buffer fills.
- **A mutex copied by value** - a struct with a `sync.Mutex` passed by value
  gives every copy its own lock. `go vet` catches this; check it runs in CI.
- **Data race on a shared map or slice** - if the diff adds concurrency, ask
  whether `-race` runs in CI.
- **`context.Background()` where a request context exists**, and a context
  stored in a struct field.

## Standard library

- **`time.Now()` comparisons across timezones**, and `time.Time` equality with
  `==` instead of `Equal` (monotonic clock and location differ).
- **`http.Response.Body` not closed**, or closed only on the success path.
- **`json.Unmarshal` into a struct silently ignores unknown fields** unless
  `DisallowUnknownFields` is set; and it leaves absent fields at their zero
  value, indistinguishable from an explicit zero without a pointer.
- **`filepath` vs `path`** - `path` is for slash-separated URLs, `filepath` for
  the OS. Mixing them breaks on Windows.
- **`os.Exit` skips deferred functions**, including buffered writer flushes.
- **`strconv.Atoi` error ignored** yields 0.

## Modules and tests

- **A dependency added to the code but not `go.mod`**, or a `replace` directive
  left in.
- **`t.Parallel()` with a shared fixture**, or with a loop variable captured
  pre-1.22.
- **`t.TempDir` vs a fixed path** shared by parallel tests.
- **A test that depends on map or file ordering.**
- **Build tags** that exclude a file from one platform's build, so a compile
  error only appears in CI.
