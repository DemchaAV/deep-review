# Pitfall catalogue: TypeScript

Read `javascript.md` as well - every runtime trap there applies. This file adds
the traps the type system creates or hides.

## Types that lie

- **`as` assertions** silence the checker without changing the value. Every
  `as` in a diff is a claim the compiler could not verify; ask what happens
  when it is false. `as unknown as T` is the same claim, louder.
- **`any` leaking through a boundary.** One `any` propagates: an `any` argument
  makes every downstream inference `any` with no error anywhere.
- **Non-null assertion `!`** on a value that genuinely can be null at runtime -
  API responses, `Map.get`, `find`, `querySelector`, `process.env.X`.
- **`process.env.X`** is `string | undefined` unless the project declares
  otherwise; code that treats it as `string` is asserting.
- **Index signatures and `noUncheckedIndexedAccess`.** Without that flag,
  `arr[i]` and `record[key]` are typed as present even when they are not.
- **Optional properties vs `undefined` values.** `{a?: number}` and
  `{a: number | undefined}` differ in whether the key may be absent -
  `exactOptionalPropertyTypes` is what separates them.

## Narrowing

- **A type guard that does not actually check** what its signature claims -
  `function isFoo(x: unknown): x is Foo { return typeof x === "object" }`.
- **Narrowing lost across an `await` or a callback** - the compiler re-widens a
  mutable property after any intervening call it cannot prove pure.
- **Discriminated unions missing a case** where the `switch` has no
  `default: assertNever(x)`, so a new variant compiles and falls through.
- **`catch (e)`** is `unknown` (or `any` under older configs) - code that reads
  `e.message` without narrowing is a runtime crash on a thrown string.

## Structure

- **Structural typing accepts extra properties** through a variable, though not
  through an object literal. A value carrying more than the type says will pass,
  and something downstream may serialise the extra fields.
- **`Promise<void>` vs `void` callbacks** - a `void`-returning callback type
  accepts an async function, whose rejection nobody awaits.
- **Enum vs union of literals** - numeric enums accept any number under some
  configs.
- **Declaration files diverging from implementation** when both are
  hand-written.

## Build

- **`skipLibCheck`, `strict` and per-file overrides** - a new file added under a
  looser config inherits weaker guarantees than its neighbours.
- **Type-only imports erased at runtime** - `import { Foo }` used only as a
  type is removed, so a module imported *solely* for its side effect disappears.
- **Path aliases** that the type checker resolves but the runtime loader does
  not, unless a resolver is configured for every entry point, tests included.
