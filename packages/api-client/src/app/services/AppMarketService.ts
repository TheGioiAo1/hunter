/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AppMarket } from '../models/AppMarket';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class AppMarketService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiAppMarket({
requestBody,
}: {
requestBody?: AppMarket,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/app-market',
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiAppMarket({
page = 1,
limit = 1,
status,
keyword,
fields,
sortBy = 'name_desc',
}: {
page?: number,
limit?: number,
status?: boolean,
keyword?: string,
fields?: string,
sortBy?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/app-market',
            query: {
                'page': page,
                'limit': limit,
                'status': status,
                'keyword': keyword,
                'fields': fields,
                'sort_by': sortBy,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static deleteApiAppMarket({
shopId,
requestBody,
}: {
shopId?: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/app-market',
            query: {
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
    public static getApiAppMarket1({
appId,
}: {
appId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/app-market/{app_id}',
            path: {
                'app_id': appId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiAppMarket({
appId,
requestBody,
}: {
appId: string,
requestBody?: AppMarket,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/app-market/{app_id}',
            path: {
                'app_id': appId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiAppMarketPublic({
page = 1,
limit = 1,
status,
keyword,
fields,
sortBy = 'name_desc',
}: {
page?: number,
limit?: number,
status?: boolean,
keyword?: string,
fields?: string,
sortBy?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/app-market/public',
            query: {
                'page': page,
                'limit': limit,
                'status': status,
                'keyword': keyword,
                'fields': fields,
                'sort_by': sortBy,
            },
        });
    }

}
