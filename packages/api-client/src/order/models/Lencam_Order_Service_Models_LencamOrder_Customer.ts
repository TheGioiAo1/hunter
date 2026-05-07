/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Lencam_Order_Service_Models_LencamOrder_CustomerManager } from './Lencam_Order_Service_Models_LencamOrder_CustomerManager';
import type { Lencam_Order_Service_Models_LencamOrder_VerifyAddress } from './Lencam_Order_Service_Models_LencamOrder_VerifyAddress';

export type Lencam_Order_Service_Models_LencamOrder_Customer = {
    id?: string | null;
    user_name?: string | null;
    shop_id?: string | null;
    address_1?: string | null;
    address_2?: string | null;
    city?: string | null;
    country_name?: string | null;
    country_code?: string | null;
    readonly full_address?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    full_name?: string | null;
    phone?: string | null;
    email?: string | null;
    province?: string | null;
    zip?: string | null;
    create_date?: string | null;
    managers?: Array<Lencam_Order_Service_Models_LencamOrder_CustomerManager> | null;
    verify_address?: Lencam_Order_Service_Models_LencamOrder_VerifyAddress;
};
