import 'dotenv/config'
import { rewriteSources } from '../packages/core/src/modules/clone-pro/v6/stages/stage8-path-rewriter.js'

const FIXTURE = `<html>
  <a href="https://bibliobloom.com/products/widget">Widget</a>
  <img src="https://cdn.shopify.com/s/files/widget.jpg">
  <a href="https://bibliobloom.com/cart">Cart</a>
  <p>Visit https://bibliobloom.com/pages/about</p>
</html>`

const rules = {
  sourceHost: 'bibliobloom.com',
  sourceCdnHosts: ['cdn.shopify.com'],
  targetCdnUrl: 'https://cdn.gbox.co/clone-storage/uuid',
  productHandleResolver: (h: string) => h,
  collectionHandleResolver: (h: string) => h,
  pageHandleResolver: (h: string) => h,
  blogResolver: (b: string, p: string) => `${b}/${p}`,
  assetMap: new Map([['https://cdn.shopify.com/s/files/widget.jpg', 'sha1abc.jpg']]),
}

const out = rewriteSources(FIXTURE, rules)
console.log(out)
if (/bibliobloom\.com/.test(out) || /cdn\.shopify\.com/.test(out)) {
  console.log('FAIL — source leak detected')
  process.exit(1)
}
console.log('Smoke pass')
