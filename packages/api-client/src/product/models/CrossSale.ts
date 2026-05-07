/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { CrossSalePosition } from './CrossSalePosition';
import type { ProductSource } from './ProductSource';

export type CrossSale = {
    id?: string | null;
    shop_id?: string | null;
    name?: string | null;
    position?: CrossSalePosition;
    message?: string | null;
    status?: boolean | null;
    created_at?: string | null;
    product_sources?: ProductSource;
    exclude_keyword?: string | null;
};
