/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { EntityObject } from './EntityObject';
import type { ItemShipping } from './ItemShipping';
import type { ShippingMethodItem } from './ShippingMethodItem';

export type ShippingMethod = {
    item_shippings?: Array<ItemShipping> | null;
    sub_entity_ids?: Array<string> | null;
    sub_entities?: Array<EntityObject> | null;
    name?: string | null;
    description?: string | null;
    type?: string | null;
    first_item_base_cost?: number | null;
    second_item_base_cost?: number | null;
    first_item_price?: number | null;
    second_item_price?: number | null;
    range_type?: string | null;
    min_value?: number | null;
    max_value?: number | null;
    items?: Array<ShippingMethodItem> | null;
    xbase?: number | null;
    price?: number | null;
    flagMaxProductId?: string | null;
};
