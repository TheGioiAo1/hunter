/**
 * Gbox Platform - Storefront API Client
 *
 * Fetches data from the Gbox REST API for storefront rendering.
 * All endpoints follow the Shopify-compatible /api/2026-04/ prefix.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Shop {
  id: string;
  name: string;
  email: string;
  domain: string;
  province: string;
  country: string;
  address1: string;
  zip: string;
  city: string;
  phone: string;
  currency: string;
  timezone: string;
  plan_name: string;
  plan_display_name: string;
  myshopify_domain: string;
  shop_owner: string;
  created_at: string;
  updated_at: string;
}

export interface ProductImage {
  id: string;
  src: string;
  alt: string;
  position: number;
  width?: number;
  height?: number;
}

export interface ProductVariant {
  id: string;
  title: string;
  price: string;
  compare_at_price: string | null;
  sku: string;
  inventory_quantity: number;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  available: boolean;
  image_id: string | null;
}

export interface Product {
  id: string;
  title: string;
  slug: string;
  body_html: string;
  vendor: string;
  product_type: string;
  status: string;
  tags: string[];
  images: ProductImage[];
  variants: ProductVariant[];
  options: { name: string; values: string[] }[];
  created_at: string;
  updated_at: string;
}

export interface Collection {
  id: string;
  title: string;
  slug: string;
  body_html: string;
  image: { src: string; alt: string } | null;
  sort_order: string;
  published_at: string;
}

export interface CartLineItem {
  id: string;
  variant_id: string;
  product_id: string;
  title: string;
  variant_title: string;
  quantity: number;
  price: string;
  image: string;
  url: string;
}

export interface Cart {
  id: string;
  token: string;
  line_items: CartLineItem[];
  item_count: number;
  total_price: string;
  currency: string;
}

export interface Page {
  id: string;
  title: string;
  slug: string;
  body_html: string;
  published_at: string;
}

export interface MenuItem {
  title: string;
  url: string;
  children: MenuItem[];
}

export interface Menu {
  handle: string;
  title: string;
  items: MenuItem[];
}

export interface BlogArticle {
  id: string;
  title: string;
  slug: string;
  body_html: string | null;
  excerpt: string | null;
  author: string | null;
  tags: string[] | null;
  image_url: string | null;
  published: boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SearchResult {
  id: string;
  title: string;
  slug: string;
  price: string;
  image: string | null;
  relevance: number;
}

export interface ProductFilters {
  status?: string;
  vendor?: string;
  product_type?: string;
  collection_id?: string;
  sort_by?: string;
  page?: number;
  limit?: number;
  min_price?: string;
  max_price?: string;
  available?: boolean;
  q?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const API_VERSION = '2026-04';

function getBaseUrl(): string {
  return import.meta.env.GBOX_API_URL || 'http://localhost:3000';
}

async function apiFetch<T>(
  path: string,
  shopId?: string,
  options?: RequestInit,
): Promise<T> {
  const url = `${getBaseUrl()}/api/${API_VERSION}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (shopId) {
    headers['X-Shop-Id'] = shopId;
  }

  const res = await fetch(url, {
    ...options,
    headers: { ...headers, ...((options?.headers as Record<string, string>) || {}) },
  });

  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${res.statusText}`);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const apiClient = {
  /**
   * Get shop by ID
   */
  async getShop(shopId: string): Promise<Shop | null> {
    try {
      const data = await apiFetch<{ shop: Shop }>('/shop.json', shopId);
      return data.shop;
    } catch {
      return null;
    }
  },

  /**
   * Resolve shop by domain hostname
   */
  async getShopByDomain(domain: string): Promise<Shop | null> {
    try {
      const data = await apiFetch<{ shop: Shop }>(
        `/shop.json?domain=${encodeURIComponent(domain)}`,
      );
      return data.shop;
    } catch {
      return null;
    }
  },

  /**
   * List products with filters and pagination
   */
  async getProducts(
    shopId: string,
    filters: ProductFilters = {},
  ): Promise<{ products: Product[]; total?: number }> {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.vendor) params.set('vendor', filters.vendor);
    if (filters.product_type) params.set('product_type', filters.product_type);
    if (filters.collection_id) params.set('collection_id', filters.collection_id);
    if (filters.sort_by) params.set('sort_by', filters.sort_by);
    if (filters.page) params.set('page', String(filters.page));
    if (filters.limit) params.set('limit', String(filters.limit));
    if (filters.min_price) params.set('min_price', filters.min_price);
    if (filters.max_price) params.set('max_price', filters.max_price);
    if (filters.available !== undefined) params.set('available', String(filters.available));
    if (filters.q) params.set('q', filters.q);

    const qs = params.toString();
    const data = await apiFetch<{ products: Product[]; total?: number }>(
      `/products.json${qs ? `?${qs}` : ''}`,
      shopId,
    );
    return data;
  },

  /**
   * Get single product by slug or ID
   */
  async getProduct(shopId: string, slugOrId: string): Promise<Product | null> {
    try {
      const data = await apiFetch<{ product: Product }>(
        `/products/${encodeURIComponent(slugOrId)}.json`,
        shopId,
      );
      return data.product;
    } catch {
      return null;
    }
  },

  /**
   * List collections
   */
  async getCollections(shopId: string): Promise<Collection[]> {
    const data = await apiFetch<{ collections: Collection[] }>(
      '/collections.json',
      shopId,
    );
    return data.collections ?? [];
  },

  /**
   * Get single collection by slug with its products
   */
  async getCollection(
    shopId: string,
    slug: string,
  ): Promise<{ collection: Collection; products: Product[] } | null> {
    try {
      const data = await apiFetch<{ collection: Collection; products: Product[] }>(
        `/collections/${encodeURIComponent(slug)}.json`,
        shopId,
      );
      return data;
    } catch {
      return null;
    }
  },

  /**
   * Get cart by token (from cookie)
   */
  async getCart(shopId: string, cartToken?: string): Promise<Cart> {
    const emptyCart: Cart = {
      id: '',
      token: '',
      line_items: [],
      item_count: 0,
      total_price: '0.00',
      currency: 'USD',
    };

    if (!cartToken) return emptyCart;

    try {
      const data = await apiFetch<{ cart: Cart }>(
        `/cart.json?token=${encodeURIComponent(cartToken)}`,
        shopId,
      );
      return data.cart ?? emptyCart;
    } catch {
      return emptyCart;
    }
  },

  /**
   * Add item to cart
   */
  async addToCart(
    shopId: string,
    cartToken: string | undefined,
    variantId: string,
    quantity: number,
  ): Promise<Cart> {
    const data = await apiFetch<{ cart: Cart }>('/cart/add.json', shopId, {
      method: 'POST',
      body: JSON.stringify({
        token: cartToken,
        items: [{ variant_id: variantId, quantity }],
      }),
    });
    return data.cart;
  },

  /**
   * Update cart line item quantity
   */
  async updateCartItem(
    shopId: string,
    cartToken: string,
    lineItemId: string,
    quantity: number,
  ): Promise<Cart> {
    const data = await apiFetch<{ cart: Cart }>('/cart/update.json', shopId, {
      method: 'POST',
      body: JSON.stringify({
        token: cartToken,
        updates: { [lineItemId]: quantity },
      }),
    });
    return data.cart;
  },

  /**
   * Remove cart line item
   */
  async removeCartItem(
    shopId: string,
    cartToken: string,
    lineItemId: string,
  ): Promise<Cart> {
    return this.updateCartItem(shopId, cartToken, lineItemId, 0);
  },

  /**
   * Get CMS pages
   */
  async getPages(shopId: string): Promise<Page[]> {
    const data = await apiFetch<{ pages: Page[] }>('/pages.json', shopId);
    return data.pages ?? [];
  },

  /**
   * Get single CMS page by slug
   */
  async getPage(shopId: string, slug: string): Promise<Page | null> {
    try {
      const data = await apiFetch<{ page: Page }>(
        `/pages/${encodeURIComponent(slug)}.json`,
        shopId,
      );
      return data.page;
    } catch {
      return null;
    }
  },

  /**
   * Search products
   */
  async searchProducts(
    shopId: string,
    query: string,
    filters: { page?: number; limit?: number } = {},
  ): Promise<{ results: SearchResult[]; total: number }> {
    const params = new URLSearchParams({ q: query, type: 'product' });
    if (filters.page) params.set('page', String(filters.page));
    if (filters.limit) params.set('limit', String(filters.limit));
    const data = await apiFetch<{ results: SearchResult[]; total: number }>(
      `/search.json?${params.toString()}`,
      shopId,
    );
    return data;
  },

  /**
   * List blog articles
   */
  async getArticles(
    shopId: string,
    filters: { page?: number; limit?: number; tag?: string } = {},
  ): Promise<{ articles: BlogArticle[]; total: number }> {
    const params = new URLSearchParams();
    params.set('published', 'true');
    if (filters.page) params.set('page', String(filters.page));
    if (filters.limit) params.set('limit', String(filters.limit));
    if (filters.tag) params.set('tag', filters.tag);
    const qs = params.toString();
    const data = await apiFetch<{ articles: BlogArticle[]; total: number }>(
      `/blogs/articles.json${qs ? `?${qs}` : ''}`,
      shopId,
    );
    return data;
  },

  /**
   * Get single blog article by slug
   */
  async getArticle(shopId: string, slug: string): Promise<BlogArticle | null> {
    try {
      const data = await apiFetch<{ article: BlogArticle }>(
        `/blogs/articles/${encodeURIComponent(slug)}.json`,
        shopId,
      );
      return data.article;
    } catch {
      return null;
    }
  },

  /**
   * Get navigation menus
   */
  async getMenus(shopId: string): Promise<Menu[]> {
    try {
      const data = await apiFetch<{ menus: Menu[] }>('/menus.json', shopId);
      return data.menus ?? [];
    } catch {
      // Menus endpoint may not exist yet; return sensible defaults
      return [
        {
          handle: 'main-menu',
          title: 'Main Menu',
          items: [
            { title: 'Home', url: '/', children: [] },
            { title: 'Shop', url: '/products', children: [] },
            { title: 'About', url: '/pages/about', children: [] },
            { title: 'Contact', url: '/pages/contact', children: [] },
          ],
        },
        {
          handle: 'footer',
          title: 'Footer',
          items: [
            { title: 'About Us', url: '/pages/about', children: [] },
            { title: 'Contact', url: '/pages/contact', children: [] },
            { title: 'Shipping Policy', url: '/pages/shipping-policy', children: [] },
            { title: 'Return Policy', url: '/pages/return-policy', children: [] },
            { title: 'Privacy Policy', url: '/pages/privacy-policy', children: [] },
            { title: 'Terms of Service', url: '/pages/terms-of-service', children: [] },
          ],
        },
      ];
    }
  },
};
