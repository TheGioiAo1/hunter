/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { CustomOptionData } from './CustomOptionData';
import type { Type } from './Type';

export type ProductCustomOption = {
    name?: string | null;
    label?: string | null;
    description?: string | null;
    placeholder?: string | null;
    max_length?: number | null;
    default_values?: Array<string> | null;
    values?: Array<string> | null;
    data?: Array<CustomOptionData> | null;
    type?: Type;
    readonly type_name?: string | null;
    required?: boolean | null;
    status?: boolean | null;
};
