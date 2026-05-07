/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { OrderCustomField } from './OrderCustomField';
import type { ProductVariant } from './ProductVariant';
import type { ShippingMethod } from './ShippingMethod';

export type CartItem = {
    id?: string | null;
    client_id?: string | null;
    product_id?: string | null;
    product_name?: string | null;
    variant?: ProductVariant;
    quantity?: number | null;
    total?: number | null;
    custom_fields?: Array<OrderCustomField> | null;
    categories?: Array<string> | null;
    tags?: Array<string> | null;
    shipping_methods?: Array<ShippingMethod> | null;
};
