/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Lencam_Order_Service_Models_LencamOrder_ItemShipping } from './Lencam_Order_Service_Models_LencamOrder_ItemShipping';
import type { Lencam_Order_Service_Models_LencamOrder_ShippingMethodItem } from './Lencam_Order_Service_Models_LencamOrder_ShippingMethodItem';

export type Lencam_Order_Service_Models_LencamOrder_ShippingMethod = {
    item_shippings?: Array<Lencam_Order_Service_Models_LencamOrder_ItemShipping> | null;
    name?: string | null;
    description?: string | null;
    xbase?: number | null;
    price?: number | null;
    pay_date?: string | null;
    type?: string | null;
    items?: Array<Lencam_Order_Service_Models_LencamOrder_ShippingMethodItem> | null;
};
