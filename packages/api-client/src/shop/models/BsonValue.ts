/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { BsonBinaryData } from './BsonBinaryData';
import type { BsonDateTime } from './BsonDateTime';
import type { BsonElement } from './BsonElement';
import type { BsonJavaScript } from './BsonJavaScript';
import type { BsonJavaScriptWithScope } from './BsonJavaScriptWithScope';
import type { BsonMaxKey } from './BsonMaxKey';
import type { BsonMinKey } from './BsonMinKey';
import type { BsonNull } from './BsonNull';
import type { BsonRegularExpression } from './BsonRegularExpression';
import type { BsonSymbol } from './BsonSymbol';
import type { BsonTimestamp } from './BsonTimestamp';
import type { BsonType } from './BsonType';
import type { BsonUndefined } from './BsonUndefined';
import type { Decimal128 } from './Decimal128';
import type { ObjectId } from './ObjectId';
import type { Regex } from './Regex';

export type BsonValue = {
    readonly asBoolean?: boolean;
    readonly asBsonArray?: Array<BsonValue> | null;
    asBsonBinaryData?: BsonBinaryData;
    asBsonDateTime?: BsonDateTime;
    readonly asBsonDocument?: Array<BsonElement> | null;
    asBsonJavaScript?: BsonJavaScript;
    asBsonJavaScriptWithScope?: BsonJavaScriptWithScope;
    asBsonMaxKey?: BsonMaxKey;
    asBsonMinKey?: BsonMinKey;
    asBsonNull?: BsonNull;
    asBsonRegularExpression?: BsonRegularExpression;
    asBsonSymbol?: BsonSymbol;
    asBsonTimestamp?: BsonTimestamp;
    asBsonUndefined?: BsonUndefined;
    asBsonValue?: BsonValue;
    readonly asByteArray?: string | null;
    /**
     * @deprecated
     */
    readonly asDateTime?: string;
    readonly asDecimal?: number;
    asDecimal128?: Decimal128;
    readonly asDouble?: number;
    readonly asGuid?: string;
    readonly asInt32?: number;
    /**
     * @deprecated
     */
    readonly asLocalTime?: string;
    readonly asInt64?: number;
    readonly asNullableBoolean?: boolean | null;
    /**
     * @deprecated
     */
    readonly asNullableDateTime?: string | null;
    readonly asNullableDecimal?: number | null;
    asNullableDecimal128?: Decimal128;
    readonly asNullableDouble?: number | null;
    readonly asNullableGuid?: string | null;
    readonly asNullableInt32?: number | null;
    readonly asNullableInt64?: number | null;
    asNullableObjectId?: ObjectId;
    asObjectId?: ObjectId;
    asRegex?: Regex;
    readonly asString?: string | null;
    /**
     * @deprecated
     */
    readonly asUniversalTime?: string;
    bsonType?: BsonType;
    readonly isBoolean?: boolean;
    readonly isBsonArray?: boolean;
    readonly isBsonBinaryData?: boolean;
    readonly isBsonDateTime?: boolean;
    readonly isBsonDocument?: boolean;
    readonly isBsonJavaScript?: boolean;
    readonly isBsonJavaScriptWithScope?: boolean;
    readonly isBsonMaxKey?: boolean;
    readonly isBsonMinKey?: boolean;
    readonly isBsonNull?: boolean;
    readonly isBsonRegularExpression?: boolean;
    readonly isBsonSymbol?: boolean;
    readonly isBsonTimestamp?: boolean;
    readonly isBsonUndefined?: boolean;
    /**
     * @deprecated
     */
    readonly isDateTime?: boolean;
    readonly isDecimal128?: boolean;
    readonly isDouble?: boolean;
    readonly isGuid?: boolean;
    readonly isInt32?: boolean;
    readonly isInt64?: boolean;
    readonly isNumeric?: boolean;
    readonly isObjectId?: boolean;
    readonly isString?: boolean;
    readonly isValidDateTime?: boolean;
    /**
     * @deprecated
     */
    readonly rawValue?: any;
};
