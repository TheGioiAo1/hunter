/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { ChargeDestinationOptions } from './ChargeDestinationOptions';
import type { ChargeLevel3Options } from './ChargeLevel3Options';
import type { ChargeShippingOptions } from './ChargeShippingOptions';
import type { ChargeTransferDataOptions } from './ChargeTransferDataOptions';
import type { StringCardCreateNestedOptionsAnyOf } from './StringCardCreateNestedOptionsAnyOf';

export type Stripe = {
    expand?: Array<string> | null;
    extraParams?: Record<string, any> | null;
    amount?: number | null;
    applicationFeeAmount?: number | null;
    capture?: boolean | null;
    currency?: string | null;
    customer?: string | null;
    description?: string | null;
    destination?: ChargeDestinationOptions;
    exchangeRate?: number | null;
    level3?: ChargeLevel3Options;
    metadata?: Record<string, string | null> | null;
    onBehalfOf?: string | null;
    receiptEmail?: string | null;
    shipping?: ChargeShippingOptions;
    source?: StringCardCreateNestedOptionsAnyOf;
    statementDescriptor?: string | null;
    statementDescriptorSuffix?: string | null;
    transferData?: ChargeTransferDataOptions;
    transferGroup?: string | null;
    public_key?: string | null;
    private_key?: string | null;
    token?: string | null;
};
