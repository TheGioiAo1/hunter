/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { ItemShippingVariant } from './ItemShippingVariant';
import type { Shipping } from './Shipping';
import type { ShippingMethod } from './ShippingMethod';

export type ItemShipping = {
    product_id?: string | null;
    product_name?: string | null;
    variant_slugs?: Array<string> | null;
    variants?: Array<ItemShippingVariant> | null;
    variant?: ItemShippingVariant;
    categories?: Array<string> | null;
    tags?: Array<string> | null;
    quantity?: number | null;
    shipping?: Array<Shipping> | null;
    shipping_methods?: Array<ShippingMethod> | null;
};
