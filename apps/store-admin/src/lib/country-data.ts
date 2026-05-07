/**
 * Shared country lookup tables — flag emoji, English name, EU member set.
 *
 * Trùng dữ liệu trong markets.ts (giữ nguyên markets.ts để không touch ngoài
 * scope). Module mới này dùng cho shipping-zone-modal và bất kỳ chỗ nào sau
 * này muốn render country list mà không phải copy lại map.
 */

export const COUNTRY_FLAG: Record<string, string> = {
  US: '🇺🇸', VN: '🇻🇳', GB: '🇬🇧', UK: '🇬🇧', AU: '🇦🇺', CA: '🇨🇦',
  JP: '🇯🇵', KR: '🇰🇷', CN: '🇨🇳', HK: '🇭🇰', SG: '🇸🇬', MY: '🇲🇾',
  TH: '🇹🇭', ID: '🇮🇩', PH: '🇵🇭', IN: '🇮🇳', NZ: '🇳🇿',
  DE: '🇩🇪', FR: '🇫🇷', IT: '🇮🇹', ES: '🇪🇸', NL: '🇳🇱', BE: '🇧🇪',
  AT: '🇦🇹', SE: '🇸🇪', DK: '🇩🇰', FI: '🇫🇮', NO: '🇳🇴', CH: '🇨🇭',
  IE: '🇮🇪', PT: '🇵🇹', PL: '🇵🇱', CZ: '🇨🇿', GR: '🇬🇷', HU: '🇭🇺',
  AE: '🇦🇪', IL: '🇮🇱', SA: '🇸🇦', TR: '🇹🇷', BR: '🇧🇷', MX: '🇲🇽',
  AR: '🇦🇷', ZA: '🇿🇦', AF: '🇦🇫',
}

export const COUNTRY_NAME: Record<string, string> = {
  US: 'United States', VN: 'Vietnam', GB: 'United Kingdom', UK: 'United Kingdom',
  AU: 'Australia', CA: 'Canada', JP: 'Japan', KR: 'South Korea', CN: 'China',
  HK: 'Hong Kong', SG: 'Singapore', MY: 'Malaysia', TH: 'Thailand', ID: 'Indonesia',
  PH: 'Philippines', IN: 'India', NZ: 'New Zealand',
  DE: 'Germany', FR: 'France', IT: 'Italy', ES: 'Spain', NL: 'Netherlands',
  BE: 'Belgium', AT: 'Austria', SE: 'Sweden', DK: 'Denmark', FI: 'Finland',
  NO: 'Norway', CH: 'Switzerland', IE: 'Ireland', PT: 'Portugal', PL: 'Poland',
  AE: 'United Arab Emirates', IL: 'Israel', BR: 'Brazil', MX: 'Mexico',
  ZA: 'South Africa', AF: 'Afghanistan',
}

export const EU_COUNTRY_CODES = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT',
  'LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE',
])

export function flagOf(code: string): string {
  return COUNTRY_FLAG[code.toUpperCase()] ?? '🌐'
}

export function nameOf(code: string): string {
  const c = code.toUpperCase()
  return COUNTRY_NAME[c] ?? c
}

const NAME_TO_CODE: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const [code, name] of Object.entries(COUNTRY_NAME)) {
    out[name.toLowerCase()] = code
  }
  return out
})()

/** Reverse lookup: country name (vd "Vietnam", "vietnam", "VIETNAM") → ISO code "VN". Trả "" nếu không match. */
export function codeOfName(name: string | null | undefined): string {
  if (!name) return ''
  return NAME_TO_CODE[String(name).trim().toLowerCase()] ?? ''
}
