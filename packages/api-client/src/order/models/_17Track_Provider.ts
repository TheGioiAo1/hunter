/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { _17Track_Event } from './_17Track_Event';

export type _17Track_Provider = {
    provider?: _17Track_Provider;
    service_type?: string | null;
    latest_sync_status?: string | null;
    latest_sync_time?: string | null;
    events_hash?: number | null;
    events?: Array<_17Track_Event> | null;
};
