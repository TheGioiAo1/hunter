/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { JumpPaymentDomain } from './JumpPaymentDomain';

export type JumpPayment = {
    status?: boolean | null;
    domains?: Array<string> | null;
    shield_domains?: Array<JumpPaymentDomain> | null;
};
