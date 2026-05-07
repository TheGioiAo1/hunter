/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Newtonsoft_Json_Linq_JToken } from './Newtonsoft_Json_Linq_JToken';
import type { Stripe_Address } from './Stripe_Address';
import type { Stripe_StripeResponse } from './Stripe_StripeResponse';

export type Stripe_Shipping = {
    readonly rawJObject?: Record<string, Newtonsoft_Json_Linq_JToken> | null;
    stripeResponse?: Stripe_StripeResponse;
    address?: Stripe_Address;
    carrier?: string | null;
    name?: string | null;
    phone?: string | null;
    trackingNumber?: string | null;
};
