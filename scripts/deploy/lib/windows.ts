/**
 * Deploy window math — GMT+7.
 *
 * Same rules as packages/agent-guard/src/deployment-safety.ts, but
 * lives here too because the deploy scripts must be runnable
 * WITHOUT loading the agent-guard package (e.g. the oncall engineer
 * runs `npx tsx scripts/deploy/check-deploy-window.ts` on server 1
 * with no npm install).
 *
 * Windows:
 *   daily  — 03:00..04:00 GMT+7 (Mon-Sat, covers 20:00..21:00 UTC prev day)
 *   sunday — 02:00..05:00 GMT+7 (covers Sat 19:00..22:00 UTC)
 */

export function insideDailyWindow(t: Date): boolean {
  const utcH = t.getUTCHours()
  const localH = (utcH + 7) % 24
  return localH === 3
}

export function insideSundayWindow(t: Date): boolean {
  const shifted = new Date(t.getTime() + 7 * 60 * 60 * 1000)
  if (shifted.getUTCDay() !== 0) return false
  const h = shifted.getUTCHours()
  return h >= 2 && h < 5
}

export function anyDeployWindow(t: Date = new Date()): boolean {
  return insideDailyWindow(t) || insideSundayWindow(t)
}
