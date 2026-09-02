# Pitfall catalogue: language-independent

Used when the diff's language has no dedicated catalogue, or alongside one when
the change spans several languages. Every item here is a question to ask of a
specific line, not a rule to recite.

## Values and boundaries

- **The empty case.** Zero items, an empty string, a zero count, a null. Which
  of these does the code treat as "missing" when one of them is legitimate
  data?
- **The boundary.** First element, last element, exactly-at-the-limit. An
  inclusive bound written as exclusive is invisible until the input is exactly
  the size that exposes it.
- **The absent case.** A lookup that misses, a key that is not present, an
  optional field. What does the code do - and is that what the caller expects?
- **Numeric range.** Overflow, truncation on conversion, floating-point
  equality, division by a value that can be zero.
- **Ordering.** Anything sorted by a comparator that is not total, or output
  that depends on the iteration order of an unordered collection.

## Control flow

- **Every condition the diff adds or edits**: state the input that makes it
  true and the input that makes it false, and check both are what the author
  intended.
- **Every error path**: is it reachable, does it clean up, does it report
  enough to diagnose, and does anything above it turn the failure back into a
  success?
- **Every early return**: what does it skip that later code assumed had run?
- **Duplicated blocks**: in the copy, is every occurrence of the first block's
  variables updated?

## Resources and state

- Anything acquired must be released **on every path**, including the failure
  paths and the early returns.
- **Shared mutable state** - is it reachable from two callers, two requests,
  two threads, or two tests? What happens when both touch it?
- **Cached values** - is the key everything that varies? What invalidates it?
- **Initialisation order** - what happens when a consumer runs before the
  setup it depends on?

## Interfaces

- **Every changed signature, return shape, status code, output field or file
  format** has consumers. They are the ones that break.
- **Backward compatibility**: what does an old client, an old config file, or
  an old stored record do against the new code?
- **Contract vs implementation**: does the declared schema, type or
  documentation still describe what the code actually produces?

## Environment

- **Paths** - separators, absolute versus relative, case sensitivity, spaces
  and non-ASCII characters.
- **Encoding and line endings** anywhere content crosses a file, a process, or
  a network boundary.
- **Time** - timezones, clock resolution, monotonic versus wall clock, and any
  comparison of timestamps produced by two different machines.
- **Locale** - case conversion, number and date formatting, and collation used
  in a comparison that should be exact.
- **Concurrency** - if the change introduces parallelism, what is now shared?

## Tests

- A test that passes for the wrong reason: an assertion that cannot fail, a
  mock that returns the expected value regardless, an async body nothing awaits.
- A test that depends on ordering, on a shared temp location, or on a value
  another test wrote.
