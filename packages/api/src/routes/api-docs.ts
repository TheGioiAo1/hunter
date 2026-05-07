/**
 * Gbox Platform — Auto-generated API Documentation
 *
 * Returns an OpenAPI 3.0 specification describing all REST API endpoints.
 *
 *   GET /api/2026-04/docs.json
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ---------------------------------------------------------------------------
// OpenAPI Spec
// ---------------------------------------------------------------------------

const API_VERSION = '2026-04'

const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Gbox Platform API',
    description: 'Shopify-compatible REST API for the Gbox e-commerce platform.',
    version: API_VERSION,
    contact: {
      name: 'Gbox Platform',
    },
  },
  servers: [
    {
      url: `/api/${API_VERSION}`,
      description: 'Current API version',
    },
  ],
  paths: {
    // -- Products -----------------------------------------------------------
    '/products.json': {
      get: {
        tags: ['Products'],
        summary: 'List products',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'draft', 'archived'] } },
          { name: 'collection_id', in: 'query', schema: { type: 'string' } },
          { name: 'vendor', in: 'query', schema: { type: 'string' } },
          { name: 'product_type', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'List of products', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProductList' } } } },
        },
      },
      post: {
        tags: ['Products'],
        summary: 'Create a product',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProductInput' } } } },
        responses: {
          201: { description: 'Created product' },
          422: { description: 'Validation error' },
        },
      },
    },
    '/products/{id}.json': {
      get: {
        tags: ['Products'],
        summary: 'Get a product',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Product details' },
          404: { description: 'Not found' },
        },
      },
      put: {
        tags: ['Products'],
        summary: 'Update a product',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProductInput' } } } },
        responses: {
          200: { description: 'Updated product' },
          404: { description: 'Not found' },
        },
      },
      delete: {
        tags: ['Products'],
        summary: 'Delete a product',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Deleted' },
        },
      },
    },

    // -- Customers ----------------------------------------------------------
    '/customers.json': {
      get: {
        tags: ['Customers'],
        summary: 'List customers',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'query', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'List of customers' } },
      },
      post: {
        tags: ['Customers'],
        summary: 'Create a customer',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomerInput' } } } },
        responses: { 201: { description: 'Created customer' } },
      },
    },
    '/customers/{id}.json': {
      get: {
        tags: ['Customers'],
        summary: 'Get a customer',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Customer details' }, 404: { description: 'Not found' } },
      },
      put: {
        tags: ['Customers'],
        summary: 'Update a customer',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Updated customer' } },
      },
      delete: {
        tags: ['Customers'],
        summary: 'Delete a customer',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Deleted' } },
      },
    },

    // -- Orders -------------------------------------------------------------
    '/orders.json': {
      get: {
        tags: ['Orders'],
        summary: 'List orders',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'financial_status', in: 'query', schema: { type: 'string' } },
          { name: 'fulfillment_status', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'List of orders' } },
      },
    },
    '/orders/{id}.json': {
      get: {
        tags: ['Orders'],
        summary: 'Get an order',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Order details' }, 404: { description: 'Not found' } },
      },
    },

    // -- Reviews ------------------------------------------------------------
    '/products/{product_id}/reviews.json': {
      get: {
        tags: ['Reviews'],
        summary: 'List product reviews (public, approved only)',
        parameters: [
          { name: 'product_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        ],
        responses: {
          200: {
            description: 'Product reviews with stats',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ProductReviewsList' } } },
          },
        },
      },
      post: {
        tags: ['Reviews'],
        summary: 'Submit a product review (public)',
        parameters: [
          { name: 'product_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ReviewInput' },
            },
          },
        },
        responses: {
          201: { description: 'Review created (pending moderation)' },
          422: { description: 'Validation error' },
        },
      },
    },
    '/reviews.json': {
      get: {
        tags: ['Reviews'],
        summary: 'List all reviews for shop (admin)',
        security: [{ apiKey: [] }],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'approved', 'rejected'] } },
        ],
        responses: { 200: { description: 'All shop reviews' } },
      },
    },
    '/reviews/{id}.json': {
      put: {
        tags: ['Reviews'],
        summary: 'Update review status (admin)',
        security: [{ apiKey: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  review: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
                    },
                    required: ['status'],
                  },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Updated review' } },
      },
      delete: {
        tags: ['Reviews'],
        summary: 'Delete a review (admin)',
        security: [{ apiKey: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Deleted' } },
      },
    },

    // -- Wishlist -----------------------------------------------------------
    '/wishlist.json': {
      get: {
        tags: ['Wishlist'],
        summary: "Get customer's wishlist",
        security: [{ apiKey: [] }],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        ],
        responses: {
          200: {
            description: 'Wishlist items with product details',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WishlistResponse' } } },
          },
        },
      },
      post: {
        tags: ['Wishlist'],
        summary: 'Add product to wishlist',
        security: [{ apiKey: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['product_id'],
                properties: { product_id: { type: 'string', format: 'uuid' } },
              },
            },
          },
        },
        responses: { 201: { description: 'Added to wishlist' } },
      },
    },
    '/wishlist/{product_id}.json': {
      delete: {
        tags: ['Wishlist'],
        summary: 'Remove product from wishlist',
        security: [{ apiKey: [] }],
        parameters: [{ name: 'product_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Removed from wishlist' } },
      },
    },
    '/wishlist/count.json': {
      get: {
        tags: ['Wishlist'],
        summary: 'Get wishlist item count',
        security: [{ apiKey: [] }],
        responses: {
          200: {
            description: 'Wishlist count',
            content: { 'application/json': { schema: { type: 'object', properties: { count: { type: 'integer' } } } } },
          },
        },
      },
    },

    // -- Search -------------------------------------------------------------
    '/search.json': {
      get: {
        tags: ['Search'],
        summary: 'Search products',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'type', in: 'query', schema: { type: 'string', default: 'product' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: { 200: { description: 'Search results' } },
      },
    },

    // -- Content (Pages & Blog) ---------------------------------------------
    '/pages.json': {
      get: { tags: ['Content'], summary: 'List pages', responses: { 200: { description: 'List of pages' } } },
      post: { tags: ['Content'], summary: 'Create a page', responses: { 201: { description: 'Created page' } } },
    },
    '/blog_posts.json': {
      get: { tags: ['Content'], summary: 'List blog posts', responses: { 200: { description: 'List of blog posts' } } },
      post: { tags: ['Content'], summary: 'Create a blog post', responses: { 201: { description: 'Created blog post' } } },
    },

    // -- Checkout ------------------------------------------------------------
    '/checkouts.json': {
      post: {
        tags: ['Checkout'],
        summary: 'Create a checkout',
        responses: { 201: { description: 'Checkout created' } },
      },
    },
    '/checkouts/{token}/complete.json': {
      post: {
        tags: ['Checkout'],
        summary: 'Complete a checkout',
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Order created' } },
      },
    },

    // -- Webhooks ------------------------------------------------------------
    '/webhooks.json': {
      get: {
        tags: ['Webhooks'],
        summary: 'List webhooks',
        security: [{ apiKey: [] }],
        responses: { 200: { description: 'List of webhooks' } },
      },
      post: {
        tags: ['Webhooks'],
        summary: 'Create a webhook',
        security: [{ apiKey: [] }],
        responses: { 201: { description: 'Webhook created' } },
      },
    },

    // -- Shop ---------------------------------------------------------------
    '/shop.json': {
      get: {
        tags: ['Shop'],
        summary: 'Get shop details',
        responses: { 200: { description: 'Shop details' } },
      },
    },
  },

  components: {
    securitySchemes: {
      apiKey: {
        type: 'apiKey' as const,
        in: 'header' as const,
        name: 'X-Gbox-Access-Token',
        description: 'API token for authenticated admin requests.',
      },
    },
    schemas: {
      ProductList: {
        type: 'object',
        properties: {
          products: { type: 'array', items: { $ref: '#/components/schemas/Product' } },
        },
      },
      Product: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          slug: { type: 'string' },
          body_html: { type: 'string', nullable: true },
          vendor: { type: 'string', nullable: true },
          product_type: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['active', 'draft', 'archived'] },
          tags: { type: 'array', items: { type: 'string' } },
          variants: { type: 'array', items: { $ref: '#/components/schemas/Variant' } },
          images: { type: 'array', items: { $ref: '#/components/schemas/Image' } },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      Variant: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          price: { type: 'string' },
          compare_at_price: { type: 'string', nullable: true },
          sku: { type: 'string', nullable: true },
          inventory_quantity: { type: 'integer' },
          option1: { type: 'string', nullable: true },
          option2: { type: 'string', nullable: true },
          option3: { type: 'string', nullable: true },
        },
      },
      Image: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          src: { type: 'string' },
          alt: { type: 'string', nullable: true },
          width: { type: 'integer', nullable: true },
          height: { type: 'integer', nullable: true },
          position: { type: 'integer' },
        },
      },
      ProductInput: {
        type: 'object',
        properties: {
          product: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string' },
              body_html: { type: 'string' },
              vendor: { type: 'string' },
              product_type: { type: 'string' },
              status: { type: 'string', enum: ['active', 'draft', 'archived'] },
              tags: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      CustomerInput: {
        type: 'object',
        properties: {
          customer: {
            type: 'object',
            properties: {
              email: { type: 'string' },
              first_name: { type: 'string' },
              last_name: { type: 'string' },
              phone: { type: 'string' },
              accepts_marketing: { type: 'boolean' },
              tags: { type: 'array', items: { type: 'string' } },
              note: { type: 'string' },
            },
          },
        },
      },
      ReviewInput: {
        type: 'object',
        required: ['review'],
        properties: {
          review: {
            type: 'object',
            required: ['author_name', 'author_email', 'rating', 'body'],
            properties: {
              author_name: { type: 'string' },
              author_email: { type: 'string', format: 'email' },
              rating: { type: 'integer', minimum: 1, maximum: 5 },
              title: { type: 'string', nullable: true },
              body: { type: 'string' },
              customer_id: { type: 'string', format: 'uuid', nullable: true },
            },
          },
        },
      },
      ProductReviewsList: {
        type: 'object',
        properties: {
          reviews: { type: 'array', items: { $ref: '#/components/schemas/Review' } },
          total: { type: 'integer' },
          avg_rating: { type: 'number' },
          stats: { $ref: '#/components/schemas/ReviewStats' },
        },
      },
      Review: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          product_id: { type: 'string', format: 'uuid' },
          author_name: { type: 'string' },
          rating: { type: 'integer', minimum: 1, maximum: 5 },
          title: { type: 'string', nullable: true },
          body: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      ReviewStats: {
        type: 'object',
        properties: {
          average: { type: 'number' },
          count: { type: 'integer' },
          distribution: {
            type: 'object',
            properties: {
              1: { type: 'integer' },
              2: { type: 'integer' },
              3: { type: 'integer' },
              4: { type: 'integer' },
              5: { type: 'integer' },
            },
          },
        },
      },
      WishlistResponse: {
        type: 'object',
        properties: {
          wishlist_items: {
            type: 'array',
            items: { $ref: '#/components/schemas/WishlistItem' },
          },
          total: { type: 'integer' },
        },
      },
      WishlistItem: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          customer_id: { type: 'string', format: 'uuid' },
          product_id: { type: 'string', format: 'uuid' },
          created_at: { type: 'string', format: 'date-time' },
          product: { $ref: '#/components/schemas/Product' },
        },
      },
    },
  },

  tags: [
    { name: 'Products', description: 'Product catalog management' },
    { name: 'Customers', description: 'Customer management' },
    { name: 'Orders', description: 'Order management' },
    { name: 'Reviews', description: 'Product reviews and ratings' },
    { name: 'Wishlist', description: 'Customer wishlist' },
    { name: 'Search', description: 'Product search' },
    { name: 'Content', description: 'Pages and blog posts' },
    { name: 'Checkout', description: 'Checkout process' },
    { name: 'Webhooks', description: 'Webhook management' },
    { name: 'Shop', description: 'Shop configuration' },
  ],
}

// ---------------------------------------------------------------------------
// GET /api/2026-04/docs.json
// ---------------------------------------------------------------------------

export async function getApiDocs(): Promise<Response> {
  return json(openApiSpec)
}
