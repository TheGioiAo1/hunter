/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Entity } from './Entity';
import type { EntityObject } from './EntityObject';
import type { ShippingMethod } from './ShippingMethod';

export type Shipping = {
    id?: string | null;
    shop_id?: string | null;
    name?: string | null;
    country_codes?: Array<string> | null;
    country_excluded?: boolean | null;
    ids?: Array<string> | null;
    entities?: Array<EntityObject> | null;
    entity?: Entity;
    entity_excluded?: boolean | null;
    shipping_methods?: Array<ShippingMethod> | null;
    preferred_rules?: string | null;
    create_date?: string | null;
    update_date?: string | null;
};
