/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Lencam_Common_CustomField } from './Lencam_Common_CustomField';
import type { Lencam_Order_Service_Models_LencamOrder_CartItem } from './Lencam_Order_Service_Models_LencamOrder_CartItem';
import type { Lencam_Order_Service_Models_LencamOrder_Customer } from './Lencam_Order_Service_Models_LencamOrder_Customer';
import type { Lencam_Order_Service_Models_LencamOrder_FixAmount } from './Lencam_Order_Service_Models_LencamOrder_FixAmount';
import type { Lencam_Order_Service_Models_LencamOrder_PushInfo } from './Lencam_Order_Service_Models_LencamOrder_PushInfo';
import type { Lencam_Order_Service_Models_LencamOrder_Tracking } from './Lencam_Order_Service_Models_LencamOrder_Tracking';

export type Lencam_Order_Service_Models_LencamOrder_Fulfillment = {
    id?: string | null;
    shop_id?: string | null;
    order_id?: string | null;
    store_id?: string | null;
    order_short_id?: string | null;
    order_number?: string | null;
    line_items?: Array<Lencam_Order_Service_Models_LencamOrder_CartItem> | null;
    notify_customer?: boolean | null;
    billing_address?: Lencam_Order_Service_Models_LencamOrder_Customer;
    shipping_address?: Lencam_Order_Service_Models_LencamOrder_Customer;
    trackings?: Array<Lencam_Order_Service_Models_LencamOrder_Tracking> | null;
    inventory_management?: string | null;
    inventory_id?: string | null;
    short_id?: string | null;
    create_date?: string | null;
    status?: boolean | null;
    custom_fields?: Array<Lencam_Common_CustomField> | null;
    shipping_method?: string | null;
    note?: string | null;
    push_info?: Lencam_Order_Service_Models_LencamOrder_PushInfo;
    export_date?: string | null;
    score?: number;
    total_transaction?: number | null;
    subtotal_base_cost?: number | null;
    tax_base_cost?: number | null;
    total_items?: number | null;
    subfee_base_cost?: number | null;
    shipping_base_cost?: number | null;
    discount_base_cost?: number | null;
    total_base_cost?: number | null;
    fix_amount?: Lencam_Order_Service_Models_LencamOrder_FixAmount;
};
