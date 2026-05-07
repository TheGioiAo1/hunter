/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { ChargeLevel3LineItemOptions } from './ChargeLevel3LineItemOptions';

export type ChargeLevel3Options = {
    customerReference?: string | null;
    lineItems?: Array<ChargeLevel3LineItemOptions> | null;
    merchantReference?: string | null;
    shippingAddressZip?: string | null;
    shippingAmount?: number | null;
    shippingFromZip?: string | null;
};
