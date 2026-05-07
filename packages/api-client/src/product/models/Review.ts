/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Product } from './Product';
import type { Reply } from './Reply';
import type { ReviewType } from './ReviewType';
import type { Status } from './Status';

export type Review = {
    id?: string | null;
    shop_id?: string | null;
    name?: string | null;
    email?: string | null;
    rating?: number | null;
    title?: string | null;
    content?: string | null;
    images?: Array<string> | null;
    type?: ReviewType;
    type_value?: string | null;
    status?: Status;
    status_value?: string | null;
    create_date?: string | null;
    collection_ids?: Array<string> | null;
    products?: Array<Product> | null;
    replies?: Array<Reply> | null;
};
