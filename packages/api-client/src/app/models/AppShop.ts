/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { User } from './User';
import type { Webhook } from './Webhook';

export type AppShop = {
    id?: string | null;
    shop_id?: string | null;
    name?: string | null;
    description?: string | null;
    developer?: User;
    created_at?: string | null;
    app_roles?: Array<string> | null;
    access_token?: string | null;
    webhooks?: Array<Webhook> | null;
    status?: boolean | null;
};
