export interface ReachabilityInput {
  htmlBody: string
  fetch?: typeof globalThis.fetch
  concurrency?: number
}

export interface ReachabilityResult {
  totalAssets: number
  ok: number
  notFound: number
  failures: { url: string; status: number }[]
}

export async function scanReachability(input: ReachabilityInput): Promise<ReachabilityResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch
  const urls = Array.from(input.htmlBody.matchAll(/(?:src|href)=["']([^"']+\.(?:jpg|jpeg|png|gif|webp|svg|css|js|woff2?|ttf|mp4))["']/gi)).map((m) => m[1])
  const unique = Array.from(new Set(urls))
  const out: ReachabilityResult = { totalAssets: unique.length, ok: 0, notFound: 0, failures: [] }
  const concurrency = input.concurrency ?? 10

  let cursor = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = cursor++
      if (idx >= unique.length) return
      const url = unique[idx]
      try {
        const res = await fetchImpl(url, { method: 'HEAD' })
        if (res.ok) out.ok++
        else { out.notFound++; out.failures.push({ url, status: res.status }) }
      } catch (err) {
        out.notFound++
        out.failures.push({ url, status: 0 })
      }
    }
  }))
  return out
}
