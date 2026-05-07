/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Lencam_Order_Service_Models_LencamOrder_Discount } from './Lencam_Order_Service_Models_LencamOrder_Discount';
import type { Lencam_Order_Service_Models_LencamOrder_ItemDiscount } from './Lencam_Order_Service_Models_LencamOrder_ItemDiscount';

export type Lencam_Order_Service_Models_LencamOrder_OrderDiscount = {
    total?: number | null;
    codes?: Array<Lencam_Order_Service_Models_LencamOrder_Discount> | null;
    data?: Array<Lencam_Order_Service_Models_LencamOrder_ItemDiscount> | null;
    items?: Array<Lencam_Order_Service_Models_LencamOrder_ItemDiscount> | null;
};
