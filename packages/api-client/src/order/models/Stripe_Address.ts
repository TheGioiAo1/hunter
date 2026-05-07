/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Newtonsoft_Json_Linq_JToken } from './Newtonsoft_Json_Linq_JToken';
import type { Stripe_StripeResponse } from './Stripe_StripeResponse';

export type Stripe_Address = {
    readonly rawJObject?: Record<string, Newtonsoft_Json_Linq_JToken> | null;
    stripeResponse?: Stripe_StripeResponse;
    city?: string | null;
    country?: string | null;
    line1?: string | null;
    line2?: string | null;
    postalCode?: string | null;
    state?: string | null;
};
