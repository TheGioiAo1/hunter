/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Lencam_Common_CustomField } from './Lencam_Common_CustomField';
import type { Lencam_Order_Service_Models_LencamOrder_FixAmount } from './Lencam_Order_Service_Models_LencamOrder_FixAmount';
import type { Lencam_Order_Service_Models_LencamOrder_ItemCheck } from './Lencam_Order_Service_Models_LencamOrder_ItemCheck';
import type { Lencam_Order_Service_Models_LencamOrder_ProductVariant } from './Lencam_Order_Service_Models_LencamOrder_ProductVariant';
import type { Lencam_Order_Service_Models_LencamOrder_ShippingMethod } from './Lencam_Order_Service_Models_LencamOrder_ShippingMethod';

export type Lencam_Order_Service_Models_LencamOrder_CartItem = {
    id?: string | null;
    client_id?: string | null;
    short_id?: string | null;
    product_id?: string | null;
    product_sku?: string | null;
    note?: string | null;
    item_note?: string | null;
    product_name?: string | null;
    product_slug?: string | null;
    variant?: Lencam_Order_Service_Models_LencamOrder_ProductVariant;
    quantity?: number | null;
    fulfillment_quantity?: number | null;
    total?: number | null;
    total_old_price?: number | null;
    total_base_cost?: number | null;
    custom_fields?: Array<Lencam_Common_CustomField> | null;
    categories?: Array<string> | null;
    tags?: Array<string> | null;
    shipping_method?: Lencam_Order_Service_Models_LencamOrder_ShippingMethod;
    shipping_methods?: Array<Lencam_Order_Service_Models_LencamOrder_ShippingMethod> | null;
    status?: string | null;
    picked_date?: string | null;
    fulfillment_date?: string | null;
    check_item_design?: Lencam_Order_Service_Models_LencamOrder_ItemCheck;
    fix_amount?: Lencam_Order_Service_Models_LencamOrder_FixAmount;
};
