/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Amount } from './Amount';
import type { SellerProtection } from './SellerProtection';

export type Capture = {
    id?: string | null;
    status?: string | null;
    amount?: Amount;
    final_capture?: boolean | null;
    seller_protection?: SellerProtection;
    create_time?: string | null;
    update_time?: string | null;
};
