// Next.js bundles pages, server actions and route handlers separately, and each bundle gets its own copy
// of a module's top-level variables. State that must be one per process (CJ's rate-limit queue, quote
// caches, in-flight imports) lives on globalThis instead, so every copy shares it.
export function processSingleton<T>(name: string, make: () => T): T {
  const g = globalThis as unknown as Record<symbol, T | undefined>;
  const key = Symbol.for(`tetherless:${name}`);
  return (g[key] ??= make());
}
