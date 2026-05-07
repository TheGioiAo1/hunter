/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Category } from './Category';
import type { ProductCustomOption } from './ProductCustomOption';
import type { ProductImage } from './ProductImage';
import type { ProductOption } from './ProductOption';
import type { ProductVariant } from './ProductVariant';
import type { SummaryReviewProduct } from './SummaryReviewProduct';

export type Product = {
    id?: string | null;
    shop_id?: string | null;
    categories?: Array<Category> | null;
    name?: string | null;
    sku?: string | null;
    slug?: string | null;
    vendor?: string | null;
    tags?: Array<string> | null;
    body_html?: string | null;
    images?: Array<ProductImage> | null;
    variant_default?: ProductVariant;
    variants?: Array<ProductVariant> | null;
    options?: Array<ProductOption> | null;
    custom_fields?: Array<ProductCustomOption> | null;
    seo_title?: string | null;
    seo_description?: string | null;
    create_date?: string | null;
    update_date?: string | null;
    published?: boolean | null;
    template?: string | null;
    views?: number | null;
    review_summary?: SummaryReviewProduct;
};
