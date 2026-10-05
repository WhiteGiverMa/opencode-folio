#!/usr/bin/env node
// Thin launcher for the compiled CLI. Run `npm run build` before direct use.
let cli
try {
  cli = await import("../dist/cli.js")
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`opencode-folio: compiled dist/ is unavailable (${message})`)
  console.error("Run `npm run build` (or install the packed package) first.")
  process.exit(2)
}
process.exitCode = await cli.main(process.argv.slice(2))
