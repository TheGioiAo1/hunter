/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Lencam_Order_Service_Models_LencamOrder_Discount } from './Lencam_Order_Service_Models_LencamOrder_Discount';

export type Lencam_Order_Service_Models_LencamOrder_ItemDiscount = {
    line_item_id?: string | null;
    product_id?: string | null;
    product_name?: string | null;
    quantity?: number | null;
    product_price?: number | null;
    product_old_price?: number | null;
    categories?: Array<string> | null;
    discount_item_price?: number | null;
    discounts?: Array<Lencam_Order_Service_Models_LencamOrder_Discount> | null;
    sub_entity_id?: string | null;
    variant_sku?: string | null;
};
