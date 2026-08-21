/**
 * Node's own type definitions are not vendored: `types` stays scoped to
 * @cloudflare/workers-types so a Workers-incompatible mistake in `src/` cannot
 * typecheck against Node's globals. Declaring the two APIs the tests use keeps
 * `npm test` free of dependencies without giving that up.
 */
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    match(value: string, pattern: RegExp, message?: string): void;
    throws(fn: () => unknown, expected?: RegExp): void;
    rejects(fn: () => Promise<unknown>, expected?: RegExp): Promise<void>;
  }

  const assert: Assert;
  export default assert;
}
