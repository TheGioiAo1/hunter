// Quick verification that the generated WORLD_MAP_PATHS module
// parses, has the expected structure, and all coords are sane.
// No DB dependency.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const modulePath = resolve(
  __dirname,
  '..',
  'src',
  'pages',
  'live-view-world-paths.ts',
)
const src = readFileSync(modulePath, 'utf-8')

// Extract the exported array contents. Simple parse: find the [ ... ]
// block after `WORLD_MAP_PATHS: string = [`.
const match = src.match(/WORLD_MAP_PATHS: string = \[([\s\S]*?)\]\.join/)
if (!match) {
  console.error('[FAIL] Could not find WORLD_MAP_PATHS array in module')
  process.exit(1)
}

// Each entry is a JSON string literal — parse them one by one.
const entryRegex = /"((?:[^"\\]|\\.)*)"/g
const entries = []
let m
while ((m = entryRegex.exec(match[1])) !== null) {
  entries.push(JSON.parse('"' + m[1] + '"'))
}

const joined = entries.join('')
const pathCount = (joined.match(/<path /g) || []).length
const moveCount = (joined.match(/M\d/g) || []).length
const lineCount = (joined.match(/L\d/g) || []).length
const closeCount = (joined.match(/Z/g) || []).length

const countryNames = []
const nameRegex = /data-n="([^"]*)"/g
let nm
while ((nm = nameRegex.exec(joined)) !== null) countryNames.push(nm[1])

const expected = ['Fiji', 'Russia', 'United States of America', 'Vietnam', 'New Zealand', 'China', 'Brazil', 'Australia', 'India', 'Japan']
const missing = expected.filter((n) => !countryNames.includes(n))

// Sanity check: parse every numeric coord and confirm in [-10, 1010].
const coords = joined.match(/\-?\d+\.\d+/g) || []
let badCount = 0
let badSamples = []
for (const c of coords) {
  const n = parseFloat(c)
  if (n < -10 || n > 1010) {
    badCount++
    if (badSamples.length < 5) badSamples.push(c)
  }
}

// Report
console.log(`module size:         ${(src.length / 1024).toFixed(1)} KB`)
console.log(`entries in array:    ${entries.length}`)
console.log(`<path> tags:         ${pathCount}`)
console.log(`M commands:          ${moveCount}`)
console.log(`L commands:          ${lineCount}`)
console.log(`Z close commands:    ${closeCount}`)
console.log(`distinct countries:  ${new Set(countryNames).size}`)
console.log(`numeric coords:      ${coords.length}`)
console.log(`coords out of range: ${badCount} ${badSamples.length ? `(sample: ${badSamples.join(', ')})` : ''}`)
console.log(`missing expected:    ${missing.length === 0 ? 'none ✓' : missing.join(', ')}`)

const ok =
  entries.length > 150 &&
  pathCount > 150 &&
  moveCount >= pathCount &&
  lineCount > 5000 &&
  missing.length === 0 &&
  badCount === 0

if (!ok) {
  console.error('\n[FAIL] verification failed')
  process.exit(1)
}
console.log('\n[ok] WORLD_MAP_PATHS verification passed')
