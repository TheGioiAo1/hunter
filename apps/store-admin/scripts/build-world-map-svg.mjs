/**
 * One-shot script: decode world-atlas@2/countries-110m.json (TopoJSON)
 * into pre-projected SVG path strings for the Live View world map.
 *
 * Output: `apps/store-admin/src/pages/live-view-world-paths.ts`, a
 * TypeScript module exporting WORLD_MAP_PATHS: the full `<path>`
 * element list (one path per country) in a 1000×500 equirectangular
 * viewBox that matches `projectLatLng()` in live-view.ts.
 *
 * Run: `node apps/store-admin/scripts/build-world-map-svg.mjs`
 *
 * Source data: cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json
 * (a pre-quantized, delta-encoded TopoJSON of every country at 1:110m
 * Natural Earth resolution — 107 KB before projection).
 *
 * Projection: identical equirectangular to live-view.ts —
 *   x = ((lng + 180) / 360) * 1000
 *   y = ((90  - lat) / 180) * 500
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const topo = JSON.parse(
  readFileSync(resolve(__dirname, '.countries-110m.json'), 'utf-8'),
)

const { scale, translate } = topo.transform
const [sx, sy] = scale
const [tx, ty] = translate

// ─── Step 1: Decode every arc from delta-encoded quantized coords
// ───────────────────────────────────────────────────────────────── to
// absolute [lng, lat] pairs.
//
// TopoJSON arc format: first point is [qx0, qy0], subsequent points are
// [dx, dy] deltas that must be accumulated. The inverse transform then
// gives real-world coordinates:
//   lng = qx * sx + tx
//   lat = qy * sy + ty
const decodedArcs = topo.arcs.map((arc) => {
  let qx = 0
  let qy = 0
  return arc.map(([dx, dy]) => {
    qx += dx
    qy += dy
    return [qx * sx + tx, qy * sy + ty]
  })
})

// ─── Step 2: Project lng/lat → SVG x/y in 1000×500 viewBox
// ──────────────────────────────────────────────────────────
function project(lng, lat) {
  const x = ((lng + 180) / 360) * 1000
  const y = ((90 - lat) / 180) * 500
  return [x, y]
}

// ─── Step 3: Given a ring of arc indices, reconstruct the full point
// list. Negative indices mean the arc is used in reverse (and bit-wise
// complemented: ~i = -i-1). TopoJSON rings share endpoints between
// adjacent arcs, so we drop the first point of each arc after the first
// to avoid dupes.
function ringToPoints(arcIndices) {
  const points = []
  arcIndices.forEach((raw, idx) => {
    let arcPts
    if (raw < 0) {
      arcPts = decodedArcs[~raw].slice().reverse()
    } else {
      arcPts = decodedArcs[raw]
    }
    if (idx === 0) {
      points.push(...arcPts)
    } else {
      points.push(...arcPts.slice(1))
    }
  })
  return points
}

// ─── Step 4: Points → "M x y L x y L x y Z" SVG path.
//
// Antimeridian handling: whenever two consecutive points have |Δlng| >
// 180°, the polygon crosses the ±180° meridian. In an equirectangular
// projection that would draw a horizontal line across the full viewBox
// (exactly the Fiji bug we saw on first pass). We fix it by emitting a
// fresh `M` subpath at the jump: the two halves get rendered separately
// with a shared fill color, which is visually correct for countries
// like Fiji, Russia's Chukchi peninsula, and Kiribati.
//
// We do NOT try to compute the exact meridian intersection — at 110m
// resolution the small triangles near ±180° are invisible anyway.
function ringToSvg(points) {
  if (points.length < 3) return ''

  let out = ''
  let prevLng = null
  let started = false

  for (let i = 0; i < points.length; i++) {
    const [lng, lat] = points[i]
    const [x, y] = project(lng, lat)

    if (!started) {
      out += `M${x.toFixed(1)} ${y.toFixed(1)}`
      started = true
    } else if (prevLng !== null && Math.abs(lng - prevLng) > 180) {
      // Dateline crossing: close current subpath, start a new one.
      out += ` Z M${x.toFixed(1)} ${y.toFixed(1)}`
    } else {
      out += ` L${x.toFixed(1)} ${y.toFixed(1)}`
    }
    prevLng = lng
  }

  out += ' Z'
  return out
}

// ─── Step 5: Build one path per country, concatenating all rings
// (exterior + holes + any multi-polygon sub-parts) into a single `d`
// attribute. SVG even-odd fill rule naturally handles holes.
const countryPaths = []

for (const geom of topo.objects.countries.geometries) {
  const name = geom.properties?.name ?? ''
  const id = geom.id ?? ''
  let d = ''

  if (geom.type === 'Polygon') {
    for (const ring of geom.arcs) {
      const pts = ringToPoints(ring)
      d += ringToSvg(pts) + ' '
    }
  } else if (geom.type === 'MultiPolygon') {
    for (const polygon of geom.arcs) {
      for (const ring of polygon) {
        const pts = ringToPoints(ring)
        d += ringToSvg(pts) + ' '
      }
    }
  }

  d = d.trim()
  if (!d) continue

  // Escape quotes/braces in tooltip name (SVG <title> fallback handled
  // by the caller — we just need a safe attribute).
  const safeName = name.replace(/"/g, '&quot;').replace(/</g, '&lt;')
  countryPaths.push(
    `<path data-c="${id}" data-n="${safeName}" d="${d}" />`,
  )
}

// ─── Step 6: Emit TypeScript module
const header = `/**
 * Auto-generated by \`apps/store-admin/scripts/build-world-map-svg.mjs\`
 * Source: world-atlas@2/countries-110m.json (Natural Earth 1:110m)
 * Projection: equirectangular, 1000×500 viewBox
 * Countries: ${countryPaths.length}
 * DO NOT EDIT BY HAND — re-run the build script instead.
 */

export const WORLD_MAP_PATHS: string = [
${countryPaths.map((p) => '  ' + JSON.stringify(p) + ',').join('\n')}
].join('')
`

const outPath = resolve(
  __dirname,
  '..',
  'src',
  'pages',
  'live-view-world-paths.ts',
)
writeFileSync(outPath, header, 'utf-8')

console.log(`✓ Wrote ${countryPaths.length} country paths → ${outPath}`)
console.log(`  Size: ${(header.length / 1024).toFixed(1)} KB`)
