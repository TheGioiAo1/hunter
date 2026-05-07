/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Lencam_Common_CustomField } from './Lencam_Common_CustomField';
import type { Lencam_Order_Service_Models_LencamOrder_CartItem } from './Lencam_Order_Service_Models_LencamOrder_CartItem';
import type { Lencam_Order_Service_Models_LencamOrder_Customer } from './Lencam_Order_Service_Models_LencamOrder_Customer';
import type { Lencam_Order_Service_Models_LencamOrder_Fulfillment } from './Lencam_Order_Service_Models_LencamOrder_Fulfillment';
import type { Lencam_Order_Service_Models_LencamOrder_OrderClient } from './Lencam_Order_Service_Models_LencamOrder_OrderClient';
import type { Lencam_Order_Service_Models_LencamOrder_OrderDiscount } from './Lencam_Order_Service_Models_LencamOrder_OrderDiscount';
import type { Lencam_Order_Service_Models_LencamOrder_OrderSubFee } from './Lencam_Order_Service_Models_LencamOrder_OrderSubFee';
import type { Lencam_Order_Service_Models_LencamOrder_PaymentMethod } from './Lencam_Order_Service_Models_LencamOrder_PaymentMethod';
import type { Lencam_Order_Service_Models_LencamOrder_ShippingMethod } from './Lencam_Order_Service_Models_LencamOrder_ShippingMethod';
import type { Lencam_Order_Service_Models_LencamOrder_Shop } from './Lencam_Order_Service_Models_LencamOrder_Shop';

export type Lencam_Order_Service_Models_LencamOrder_Order = {
    id?: string | null;
    session_id?: string | null;
    client_id?: string | null;
    order_number?: string | null;
    shop_id?: string | null;
    short_id?: string | null;
    custom_fields?: Array<Lencam_Common_CustomField> | null;
    isVerified?: boolean | null;
    custom_field?: Array<Lencam_Common_CustomField> | null;
    billing_address?: Lencam_Order_Service_Models_LencamOrder_Customer;
    shipping_address?: Lencam_Order_Service_Models_LencamOrder_Customer;
    shipping_method?: Lencam_Order_Service_Models_LencamOrder_ShippingMethod;
    payment_method?: Lencam_Order_Service_Models_LencamOrder_PaymentMethod;
    payment_status?: boolean | null;
    referring_site?: string | null;
    client_details?: Lencam_Order_Service_Models_LencamOrder_OrderClient;
    line_items?: Array<Lencam_Order_Service_Models_LencamOrder_CartItem> | null;
    total_items?: number | null;
    subtotal_price?: number | null;
    subtotal_base_code?: number | null;
    total_transaction?: number | null;
    tax?: number | null;
    tip_value?: number | null;
    total_price?: number | null;
    total_base_cost?: number | null;
    note?: string | null;
    status?: string | null;
    currency?: string | null;
    tags?: Array<string> | null;
    create_date?: string | null;
    update_date?: string | null;
    shop?: Lencam_Order_Service_Models_LencamOrder_Shop;
    subfee?: Lencam_Order_Service_Models_LencamOrder_OrderSubFee;
    discount?: Lencam_Order_Service_Models_LencamOrder_OrderDiscount;
    fulfillments?: Array<Lencam_Order_Service_Models_LencamOrder_Fulfillment> | null;
    score?: number;
};
