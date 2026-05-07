/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CartItem } from '../models/CartItem';
import type { Entity } from '../models/Entity';
import type { Shipping } from '../models/Shipping';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class ShippingService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiTest({
shopId,
countryCode,
requestBody,
}: {
shopId: string,
countryCode: string,
requestBody?: CartItem,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/test/{country_code}',
            path: {
                'shop_id': shopId,
                'country_code': countryCode,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiCheckout({
shopId,
countryCode,
requestBody,
}: {
shopId: string,
countryCode: string,
requestBody?: Array<CartItem>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/checkout/{countryCode}',
            path: {
                'shop_id': shopId,
                'countryCode': countryCode,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApi({
shippingId,
shopId,
}: {
shippingId: string,
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/{shipping_id}',
            path: {
                'shipping_id': shippingId,
                'shop_id': shopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApi({
shippingId,
shopId,
requestBody,
}: {
shippingId: string,
shopId: string,
requestBody?: Shipping,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/{shipping_id}',
            path: {
                'shipping_id': shippingId,
                'shop_id': shopId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static deleteApi({
shippingId,
shopId,
}: {
shippingId: string,
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/{shipping_id}',
            path: {
                'shipping_id': shippingId,
                'shop_id': shopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApi1({
shopId,
field,
keyword,
}: {
shopId: string,
field?: string,
keyword?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}',
            path: {
                'shop_id': shopId,
            },
            query: {
                'field': field,
                'keyword': keyword,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApi({
shopId,
shippingId,
requestBody,
}: {
shopId: string,
shippingId?: string,
requestBody?: Shipping,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}',
            path: {
                'shop_id': shopId,
            },
            query: {
                'shipping_id': shippingId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiImport({
shopId,
preview = true,
formData,
}: {
shopId: string,
preview?: boolean,
formData?: {
file?: Blob;
},
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/import',
            path: {
                'shop_id': shopId,
            },
            query: {
                'preview': preview,
            },
            formData: formData,
            mediaType: 'multipart/form-data',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiExport({
shopId,
ids,
countryCode,
entityIds,
entity,
subEntityIds,
keyword,
}: {
shopId: string,
ids?: string,
countryCode?: string,
entityIds?: string,
entity?: Entity,
subEntityIds?: string,
keyword?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/export',
            path: {
                'shop_id': shopId,
            },
            query: {
                'ids': ids,
                'country_code': countryCode,
                'entity_ids': entityIds,
                'entity': entity,
                'sub_entity_ids': subEntityIds,
                'keyword': keyword,
            },
        });
    }

}
