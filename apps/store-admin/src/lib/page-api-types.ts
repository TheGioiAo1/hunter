/**
 * Types khớp 1-1 BE Gbox-Page-Service Page model (xác nhận qua
 * https://api-page.gbox.co/swagger/v1/swagger.json).
 *
 * Mọi field nullable theo BE [DataMember(EmitDefaultValue=false)] +
 * `additionalProperties: false` trong swagger. Tuy nhiên store-admin
 * thường có giá trị → giữ optional thay nullable cho dễ dùng.
 */

export interface ApiImageObject {
  position: number
  url?: string
}

export interface ApiCustomField {
  name?: string
  value?: string
}

export interface ApiPage {
  id?: string
  title?: string
  slug?: string
  content?: string
  seo_title?: string
  seo_description?: string
  shop_id?: string
  tags?: string[]
  published?: boolean
  template?: string
  image_url?: string
  images?: ApiImageObject[]
  created_at?: string
  /** BE chưa document semantic — bỏ khỏi UI Phase này. */
  finished_at?: string
  updated_at?: string
  custom_fields?: ApiCustomField[]
}

export interface ApiPagination {
  page?: number
  limit?: number
  count?: number
}

export interface ApiPageListResponse {
  pagination?: ApiPagination
  data?: ApiPage[]
}

export interface ListPagesOpts {
  page?: number
  limit?: number
  /** Comma-separated tag list khi truyền BE. */
  tags?: string
  keyword?: string
  /** Comma-separated field list. Default ở client lấy đủ field UI cần. */
  fields?: string
  published?: boolean
  /**
   * BE ngầm hiểu format `<field>_<asc|desc>`. Default `id_desc`.
   * Common: `updated_at_desc`, `created_at_desc`, `title_asc`.
   */
  sort_by?: string
}

/** Body cho DELETE /api/{shop_id} — BE expect List<Page>. */
export interface DeletePageItem {
  id: string
  shop_id?: string
  slug?: string
}
