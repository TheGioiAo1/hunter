/**
 * Types cho Gbox-Page-Service — Blog + Article endpoints.
 * Base: API_PAGE_BASE_URL / api/{shop_id}/blogs/...
 */

export interface ApiBlog {
  id?: string
  shop_id?: string
  title?: string
  slug?: string
  commentable?: boolean
  template?: string
  rss_enabled?: boolean
  tags?: string[]
  created_at?: string
  updated_at?: string
}

export interface ApiArticle {
  id?: string
  blog_id?: string
  shop_id?: string
  title?: string
  slug?: string
  author?: string
  author_id?: string
  body_html?: string
  summary_html?: string
  image_url?: string
  tags?: string[]
  published?: boolean
  published_at?: string
  seo_title?: string
  seo_description?: string
  template?: string
  custom_fields?: { name?: string; value?: string }[]
  created_at?: string
  updated_at?: string
}

export interface ApiBlogListResponse {
  pagination?: { page?: number; limit?: number; count?: number; total_page?: number }
  data?: ApiBlog[]
}

export interface ApiArticleListResponse {
  pagination?: { page?: number; limit?: number; count?: number; total_page?: number }
  data?: ApiArticle[]
}

export interface ListArticlesOpts {
  page?: number
  limit?: number
  keyword?: string
  tags?: string
  published?: boolean
  fields?: string
  sort_by?: string
}
