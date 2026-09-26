// Post-compile fix: rewrite extensionless relative imports to .js so the
// emitted ESM runs in Node directly (pi-vcc sources use extensionless paths).
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) { console.error('usage: node fix-imports.mjs <dir>'); process.exit(1) }

const files = []
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (p.endsWith('.js')) files.push(p)
  }
}
walk(root)

const RE = /(from\s*["'])(\.{1,2}\/[^"']+?)(["'])/g
let changed = 0
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const out = src.replace(RE, (m, pre, spec, post) => {
    if (/\.(js|json|mjs|cjs)$/.test(spec)) return m
    return `${pre}${spec}.js${post}`
  })
  if (out !== src) { writeFileSync(f, out); changed++ }
}
console.log(`fixed ${changed}/${files.length} files`)
