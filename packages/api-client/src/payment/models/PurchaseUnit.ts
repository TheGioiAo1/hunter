/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Amount } from './Amount';
import type { Payee } from './Payee';
import type { Payments } from './Payments';
import type { Shipping } from './Shipping';

export type PurchaseUnit = {
    reference_id?: string | null;
    amount?: Amount;
    payee?: Payee;
    description?: string | null;
    soft_descriptor?: string | null;
    shipping?: Shipping;
    payments?: Payments;
};
