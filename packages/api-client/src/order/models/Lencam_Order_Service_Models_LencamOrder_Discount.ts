/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Lencam_Common_DiscountEntity } from './Lencam_Common_DiscountEntity';
import type { Lencam_Common_DiscountType } from './Lencam_Common_DiscountType';
import type { Lencam_Common_RangeType } from './Lencam_Common_RangeType';
import type { Lencam_Order_Service_Models_LencamOrder_EntityObject } from './Lencam_Order_Service_Models_LencamOrder_EntityObject';

export type Lencam_Order_Service_Models_LencamOrder_Discount = {
    id?: string | null;
    shop_id?: string | null;
    name?: string | null;
    code?: string | null;
    is_auto?: boolean | null;
    discount_type?: Lencam_Common_DiscountType;
    readonly type_name?: string | null;
    discount_value?: number | null;
    start_date?: string | null;
    end_date?: string | null;
    range_type?: Lencam_Common_RangeType;
    readonly range_name?: string | null;
    min_value?: number | null;
    max_value?: number | null;
    ids?: Array<string> | null;
    entities?: Array<Lencam_Order_Service_Models_LencamOrder_EntityObject> | null;
    entity_excluded?: boolean | null;
    entity?: Lencam_Common_DiscountEntity;
    readonly entity_name?: string | null;
    individual_use?: boolean | null;
    excluded_sale_items?: boolean | null;
    customer_emails?: Array<string> | null;
    status?: boolean | null;
    created_at?: string | null;
    usage_limit?: number | null;
    usage_limit_per_user?: number | null;
    price?: number | null;
    sub_entity_id?: string | null;
    sub_entity_sku?: string | null;
};
