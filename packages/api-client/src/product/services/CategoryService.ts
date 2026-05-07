/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Category } from '../models/Category';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class CategoryService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiCategory({
shopId,
keyword,
page = 1,
limit = 250,
status,
executeIds,
sortBy,
fields,
}: {
shopId: string,
keyword?: string,
page?: number,
limit?: number,
status?: boolean,
executeIds?: string,
sortBy?: string,
fields?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/category',
            path: {
                'shop_id': shopId,
            },
            query: {
                'keyword': keyword,
                'page': page,
                'limit': limit,
                'status': status,
                'execute_ids': executeIds,
                'sort_by': sortBy,
                'fields': fields,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiCategory({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Category,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/category',
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
    public static deleteApiCategory({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/category',
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
    public static getApiCategory1({
shopId,
idOrSlug,
}: {
shopId: string,
idOrSlug: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/category/{IdOrSlug}',
            path: {
                'shop_id': shopId,
                'IdOrSlug': idOrSlug,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiCategory({
shopId,
categoryId,
requestBody,
}: {
shopId: string,
categoryId: string,
requestBody?: Category,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/category/{category_id}',
            path: {
                'shop_id': shopId,
                'category_id': categoryId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static deleteApiCategory1({
shopId,
categoryId,
}: {
shopId: string,
categoryId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/category/{category_id}',
            path: {
                'shop_id': shopId,
                'category_id': categoryId,
            },
        });
    }

}
