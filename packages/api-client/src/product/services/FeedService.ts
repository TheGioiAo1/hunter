/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class FeedService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiFeed({
shopId,
}: {
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/feed',
            path: {
                'shop_id': shopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiFeed({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/feed',
            path: {
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
    public static deleteApiFeed({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/feed',
            path: {
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
    public static getApiFeed1({
shopId,
type,
key,
dynamic = true,
limit = 250,
random = false,
category,
crossShopId,
}: {
shopId: string,
type: string,
key?: string,
dynamic?: boolean,
limit?: number,
random?: boolean,
category?: string,
crossShopId?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/feed/{type}',
            path: {
                'shop_id': shopId,
                'type': type,
            },
            query: {
                'key': key,
                'dynamic': dynamic,
                'limit': limit,
                'random': random,
                'category': category,
                'cross_shop_id': crossShopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiFeed({
id,
shopId,
requestBody,
}: {
id: number,
shopId: string,
requestBody?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/feed/{id}',
            path: {
                'id': id,
                'shop_id': shopId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

}
