/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { BulkUpdatesAction } from './BulkUpdatesAction';
import type { BulkUpdatesFilter } from './BulkUpdatesFilter';
import type { FilterType } from './FilterType';

export type ProductBulkUpdates = {
    filter_type?: FilterType;
    filters?: Array<BulkUpdatesFilter> | null;
    actions?: Array<BulkUpdatesAction> | null;
};
