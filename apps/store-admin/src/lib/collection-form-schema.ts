/**
 * Zod schema cho collection create / update payload.
 * Mirror với Category DTO của .NET API.
 * Slug auto-generate: lowercase + normalize Vietnamese diacritics → hyphens.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Vietnamese diacritics normalization
// ---------------------------------------------------------------------------

const VIET_MAP: Record<string, string> = {
  à: 'a', á: 'a', ả: 'a', ã: 'a', ạ: 'a',
  ă: 'a', ắ: 'a', ặ: 'a', ằ: 'a', ẳ: 'a', ẵ: 'a',
  â: 'a', ấ: 'a', ầ: 'a', ẩ: 'a', ẫ: 'a', ậ: 'a',
  è: 'e', é: 'e', ẻ: 'e', ẽ: 'e', ẹ: 'e',
  ê: 'e', ế: 'e', ề: 'e', ể: 'e', ễ: 'e', ệ: 'e',
  ì: 'i', í: 'i', ỉ: 'i', ĩ: 'i', ị: 'i',
  ò: 'o', ó: 'o', ỏ: 'o', õ: 'o', ọ: 'o',
  ô: 'o', ố: 'o', ồ: 'o', ổ: 'o', ỗ: 'o', ộ: 'o',
  ơ: 'o', ớ: 'o', ờ: 'o', ở: 'o', ỡ: 'o', ợ: 'o',
  ù: 'u', ú: 'u', ủ: 'u', ũ: 'u', ụ: 'u',
  ư: 'u', ứ: 'u', ừ: 'u', ử: 'u', ữ: 'u', ự: 'u',
  ỳ: 'y', ý: 'y', ỷ: 'y', ỹ: 'y', ỵ: 'y',
  đ: 'd',
}

/**
 * Derive URL-safe slug từ tên — hỗ trợ tiếng Việt có dấu.
 * "Áo dài" → "ao-dai", "Summer Collection 2026" → "summer-collection-2026"
 */
export function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .split('')
    .map((c) => VIET_MAP[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const collectionCreateSchema = z.object({
  name: z.string().min(1, 'Tên collection là bắt buộc').max(200, 'Tên tối đa 200 ký tự').trim(),
  slug: z.string().max(100, 'Slug tối đa 100 ký tự').optional(),
  description: z.string().max(5000, 'Mô tả tối đa 5000 ký tự').optional(),
  image_url: z.string().url('image_url phải là URL hợp lệ').optional().or(z.literal('')),
  status: z.boolean().optional().default(true),
  seo_title: z.string().max(200, 'SEO title tối đa 200 ký tự').optional(),
  seo_description: z.string().max(320, 'SEO description tối đa 320 ký tự').optional(),
})

export const collectionUpdateSchema = collectionCreateSchema

export type CollectionCreateInput = z.infer<typeof collectionCreateSchema>
export type CollectionUpdateInput = z.infer<typeof collectionUpdateSchema>

/**
 * Parse + validate raw form body (req.body) từ Express.
 * Trả { data } khi hợp lệ, { errors } khi không.
 */
export function parseCollectionForm(body: Record<string, unknown>):
  | { data: CollectionCreateInput; errors: null }
  | { data: null; errors: Record<string, string> } {
  const raw = {
    name: typeof body.name === 'string' ? body.name.trim() : '',
    slug: typeof body.slug === 'string' ? body.slug.trim() : undefined,
    description: typeof body.description === 'string' ? body.description.trim() : undefined,
    image_url: typeof body.image_url === 'string' ? body.image_url.trim() : undefined,
    // checkbox sends 'true' | 'on' | '1' | undefined
    status: body.status === 'true' || body.status === 'on' || body.status === '1' || body.status === true,
    seo_title: typeof body.seo_title === 'string' ? body.seo_title.trim() : undefined,
    seo_description: typeof body.seo_description === 'string' ? body.seo_description.trim() : undefined,
  }

  const result = collectionCreateSchema.safeParse(raw)
  if (!result.success) {
    const errors: Record<string, string> = {}
    for (const issue of result.error.issues) {
      const key = issue.path[0] as string
      errors[key] = issue.message
    }
    return { data: null, errors }
  }

  // Auto-generate slug if empty
  if (!result.data.slug) {
    result.data.slug = deriveSlug(result.data.name)
  }

  return { data: result.data, errors: null }
}
