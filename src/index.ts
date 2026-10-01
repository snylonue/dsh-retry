/**
 * `dsh-retry-button` host half.
 *
 * This is a pure UI plugin: it contributes no host service, tool, or event
 * listener. The empty `apply` exists so the package appears as a Loader entry
 * on the host, which is exactly how `@deepseek-ai/dsh-client-modules`
 * discovers a package's browser half — it scans live Loader entries by name,
 * reads `exports["./client"]`, and serves that bundle under `/plugins`.
 *
 * All behavior lives in `client.tsx`.
 *
 * @module dsh-retry-button
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}