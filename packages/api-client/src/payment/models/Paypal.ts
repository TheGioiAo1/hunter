/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Link } from './Link';
import type { Payer } from './Payer';
import type { PurchaseUnit } from './PurchaseUnit';

export type Paypal = {
    id?: string | null;
    intent?: string | null;
    status?: string | null;
    purchase_units?: Array<PurchaseUnit> | null;
    payer?: Payer;
    create_time?: string | null;
    update_time?: string | null;
    links?: Array<Link> | null;
};
