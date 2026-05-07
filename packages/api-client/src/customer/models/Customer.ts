/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { CustomerManager } from './CustomerManager';
import type { CustomField } from './CustomField';
import type { InvoiceInfo } from './InvoiceInfo';
import type { Referrer } from './Referrer';

export type Customer = {
    id?: string | null;
    shop_id?: string | null;
    address_1?: string | null;
    is_test?: boolean | null;
    address_2?: string | null;
    password?: string | null;
    city?: string | null;
    short_id?: string | null;
    rate_vnd_usd?: number | null;
    user_name?: string | null;
    personal_id?: string | null;
    country_name?: string | null;
    country_code?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    full_name?: string | null;
    phone?: string | null;
    email?: string | null;
    province?: string | null;
    token?: string | null;
    zip?: string | null;
    customFields?: Array<CustomField> | null;
    roles?: Array<string> | null;
    managers?: Array<CustomerManager> | null;
    referrer?: Referrer;
    source?: string | null;
    created_at?: string | null;
    invoice_info?: InvoiceInfo;
};
