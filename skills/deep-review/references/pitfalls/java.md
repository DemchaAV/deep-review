# Pitfall catalogue: Java / Kotlin / JVM

## Java language traps

- **`==` on boxed types and strings.** Works for cached small values and
  interned literals, fails for everything else. `Integer` caches -128..127.
- **Autoboxing NPE** - a `null` `Integer` unboxed in arithmetic or a ternary
  whose branches have different box types.
- **`equals` without `hashCode`** (and either without a stable field set)
  breaks every hash collection silently.
- **Mutable state escaping a constructor** - `this` published before the object
  is fully built, or a collection field returned directly instead of a copy.
- **`Arrays.asList` and `List.of`** return fixed-size or immutable lists;
  `add` throws at runtime, not compile time.
- **Integer overflow** in `int` arithmetic that should have been `long` -
  timestamps, byte counts, products of two sizes.
- **`float`/`double` for money** and `==` on floating point.
- **String concatenation in a loop** where the loop is hot.
- **Checked exception swallowed** in an empty `catch`, or a `catch (Exception)`
  around a block whose only real failure mode is a bug.
- **`Optional` fields and parameters** - `Optional` is a return type; an
  `Optional` field that is itself null is the worst of both.
- **Try-with-resources missing** on anything `Closeable`, and a resource opened
  in the `try` header expression that leaks when a *later* one throws.
- **Static mutable state** in a class used from more than one thread or test.

## Kotlin specifics

- **Platform types from Java interop** (`String!`) bypass null checks - a value
  the compiler will not protect.
- **`lateinit`** read before assignment throws `UninitializedPropertyAccessException`.
- **`!!`** is an assertion; each one is a claim to verify.
- **Data class `copy` and `equals` ignore custom properties** declared in the
  body rather than the constructor.
- **Extension functions resolve statically** - a receiver typed as the
  supertype calls the supertype's extension.
- **Default arguments plus overloads** - the JVM signature the caller binds to
  may not be the one intended, especially from Java.
- **`runBlocking` inside a coroutine** and launching into `GlobalScope` -
  structured concurrency is lost and cancellation does not propagate.

## Concurrency

- **Non-atomic check-then-act** on a `ConcurrentHashMap` - `containsKey` then
  `put` is not `computeIfAbsent`.
- **`synchronized` on a mutable field reference** rather than a stable lock.
- **A field read from multiple threads without `volatile`** or a happens-before
  edge.
- **Executor never shut down**, or shut down without awaiting termination.
- **`ThreadLocal` not removed** in a pooled-thread environment - a leak and a
  cross-request data bleed.

## Collections and streams

- **Modifying a collection while iterating it.**
- **`Collectors.toMap` throws on duplicate keys** and rejects null values.
- **A stream consumed twice**, or a parallel stream over a non-thread-safe
  accumulator.
- **`Comparator` that is not transitive** or that compares by subtraction and
  overflows.

## Resources, encoding, platform

- **Charset-dependent APIs** without an explicit charset - `new String(bytes)`,
  `FileReader`, `String.getBytes()`.
- **`File.separator` assumptions** and paths built by string concatenation.
- **Locale-dependent `toLowerCase()` / `toUpperCase()`** - the Turkish dotless
  i changes identifier comparisons. Use the `Locale.ROOT` overload.
- **Classpath resource loading** with a leading slash difference between
  `Class` and `ClassLoader`.
- **Timezone-dependent date handling** where the test machine and CI differ.

## Build and tests

- **A dependency added in one module's build file but used in another.**
- **Test ordering assumptions** and shared static fixtures between test classes.
- **A test asserting on a message string** produced by a library that may
  change it.
