/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CrossSale } from '../models/CrossSale';
import type { Product } from '../models/Product';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class CrossSaleService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiCrossSaleFront({
shopId,
position,
fields = 'name,variant_default,variants,options',
requestBody,
}: {
shopId: string,
position?: string,
fields?: string,
requestBody?: Product,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/cross-sale/front',
            path: {
                'shop_id': shopId,
            },
            query: {
                'position': position,
                'fields': fields,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiCrossSaleList({
shopId,
page = 1,
limit = 250,
position,
status,
keyword,
fields,
sortBy = 'id_desc',
}: {
shopId: string,
page?: number,
limit?: number,
position?: number,
status?: boolean,
keyword?: string,
fields?: string,
sortBy?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/cross-sale/list',
            path: {
                'shop_id': shopId,
            },
            query: {
                'page': page,
                'limit': limit,
                'position': position,
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
    public static getApiCrossSale({
shopId,
id,
}: {
shopId: string,
id: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/cross-sale/{id}',
            path: {
                'shop_id': shopId,
                'id': id,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiCrossSale({
shopId,
id,
requestBody,
}: {
shopId: string,
id: string,
requestBody?: CrossSale,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/cross-sale/{id}',
            path: {
                'shop_id': shopId,
                'id': id,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static deleteApiCrossSale({
shopId,
id,
}: {
shopId: string,
id: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/cross-sale/{id}',
            path: {
                'shop_id': shopId,
                'id': id,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiCrossSale({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: CrossSale,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/cross-sale',
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
    public static deleteApiCrossSale1({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/cross-sale',
            path: {
                'shop_id': shopId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

}
