/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { BsonValue } from './BsonValue';
import type { EntityType } from './EntityType';
import type { LanguageCode } from './LanguageCode';

export type Translate = {
    id?: string | null;
    shop_id?: string | null;
    language_code?: LanguageCode;
    entity_id?: string | null;
    entity_type?: EntityType;
    dataDb?: Record<string, BsonValue> | null;
    dataDto?: Record<string, any> | null;
    created_at?: string | null;
    updated_at?: string | null;
};
