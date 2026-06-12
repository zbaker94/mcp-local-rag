// Faithful test double for `formatCliError` (src/cli/common.ts).
//
// CLI subcommand tests mock `../../cli/common.js` wholesale, so they must
// supply their own `formatCliError`. This shim mirrors the production
// rendering (full `.cause` chain + stacks, deeper links prefixed
// `Caused by: `) so failure-path assertions exercise real behavior — the
// cause chain reaches stderr, exactly as the Contract-Delta CLI row requires —
// rather than a message-only stub.

export function formatCliErrorShim(error: unknown): string {
  const err = error instanceof Error ? error : new Error(String(error))
  const chain: Error[] = []
  const seen = new Set<Error>()
  let current: Error | undefined = err
  while (current !== undefined && !seen.has(current)) {
    chain.push(current)
    seen.add(current)
    const next: unknown = current.cause
    current = next instanceof Error ? next : undefined
  }
  return chain
    .map((link, index) => {
      const header = index === 0 ? '' : 'Caused by: '
      return `${header}${link.stack || `${link.name}: ${link.message}`}`
    })
    .join('\n')
}
