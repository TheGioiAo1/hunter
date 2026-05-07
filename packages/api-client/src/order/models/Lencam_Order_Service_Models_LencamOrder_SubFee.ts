/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Lencam_Common_DiscountEntity } from './Lencam_Common_DiscountEntity';
import type { Lencam_Order_Service_Models_LencamOrder_EntityObject } from './Lencam_Order_Service_Models_LencamOrder_EntityObject';

export type Lencam_Order_Service_Models_LencamOrder_SubFee = {
    id?: string | null;
    shop_id?: string | null;
    name?: string | null;
    description?: string | null;
    country_codes?: Array<string> | null;
    country_excluded?: boolean | null;
    ids?: Array<string> | null;
    entities?: Array<Lencam_Order_Service_Models_LencamOrder_EntityObject> | null;
    entity?: Lencam_Common_DiscountEntity;
    readonly entity_name?: string | null;
    entity_excluded?: boolean | null;
    first_item_price?: number | null;
    second_item_price?: number | null;
    price?: number | null;
    create_date?: string | null;
    update_date?: string | null;
};
