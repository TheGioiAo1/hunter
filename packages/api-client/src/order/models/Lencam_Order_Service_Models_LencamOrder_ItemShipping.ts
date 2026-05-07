/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Lencam_Order_Service_Models_LencamOrder_ShippingMethod } from './Lencam_Order_Service_Models_LencamOrder_ShippingMethod';
import type { Stripe_Shipping } from './Stripe_Shipping';

export type Lencam_Order_Service_Models_LencamOrder_ItemShipping = {
    product_id?: string | null;
    variant_slugs?: Array<string> | null;
    categories?: Array<string> | null;
    quantity?: number | null;
    shipping?: Array<Stripe_Shipping> | null;
    shipping_methods?: Array<Lencam_Order_Service_Models_LencamOrder_ShippingMethod> | null;
};
