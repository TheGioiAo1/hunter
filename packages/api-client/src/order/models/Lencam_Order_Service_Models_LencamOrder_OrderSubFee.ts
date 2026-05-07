/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Lencam_Order_Service_Models_LencamOrder_ItemSubFee } from './Lencam_Order_Service_Models_LencamOrder_ItemSubFee';
import type { Lencam_Order_Service_Models_LencamOrder_OrderSubfeeLineShipping } from './Lencam_Order_Service_Models_LencamOrder_OrderSubfeeLineShipping';

export type Lencam_Order_Service_Models_LencamOrder_OrderSubFee = {
    total?: number | null;
    data?: Array<Lencam_Order_Service_Models_LencamOrder_ItemSubFee> | null;
    subfee_lineship?: Lencam_Order_Service_Models_LencamOrder_OrderSubfeeLineShipping;
};
