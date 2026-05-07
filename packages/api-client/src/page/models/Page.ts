/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { CustomField } from './CustomField';
import type { ImageObject } from './ImageObject';

export type Page = {
    id?: string | null;
    title?: string | null;
    slug?: string | null;
    content?: string | null;
    seo_title?: string | null;
    seo_description?: string | null;
    shop_id?: string | null;
    tags?: Array<string> | null;
    published?: boolean | null;
    template?: string | null;
    image_url?: string | null;
    images?: Array<ImageObject> | null;
    created_at?: string | null;
    finished_at?: string | null;
    updated_at?: string | null;
    custom_fields?: Array<CustomField> | null;
};
