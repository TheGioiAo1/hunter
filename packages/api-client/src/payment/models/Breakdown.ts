/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Handling } from './Handling';
import type { Insurance } from './Insurance';
import type { ItemTotal } from './ItemTotal';
import type { Shipping } from './Shipping';
import type { ShippingDiscount } from './ShippingDiscount';
import type { TaxTotal } from './TaxTotal';

export type Breakdown = {
    item_total?: ItemTotal;
    shipping?: Shipping;
    handling?: Handling;
    tax_total?: TaxTotal;
    insurance?: Insurance;
    shipping_discount?: ShippingDiscount;
};
