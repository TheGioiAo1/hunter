/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Lencam_Order_Service_Models_LencamOrder_SubFee } from './Lencam_Order_Service_Models_LencamOrder_SubFee';

export type Lencam_Order_Service_Models_LencamOrder_ItemSubFee = {
    product_id?: string | null;
    product_name?: string | null;
    categories?: Array<string> | null;
    quantity?: number | null;
    sub_fees?: Array<Lencam_Order_Service_Models_LencamOrder_SubFee> | null;
    readonly price?: number | null;
};
