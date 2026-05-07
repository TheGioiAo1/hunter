/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Page } from '../models/Page';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class PageService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiViewCounter({
slug,
shopId,
}: {
slug: string,
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/{slug}/view_counter',
            path: {
                'slug': slug,
                'shop_id': shopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApi({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Page,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}',
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
    public static putApi({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Page,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}',
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
    public static getApi({
shopId,
page = 1,
limit = 250,
tags,
keyword,
fields,
published,
sortBy = 'id_desc',
}: {
shopId: string,
page?: number,
limit?: number,
tags?: string,
keyword?: string,
fields?: string,
published?: boolean,
sortBy?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}',
            path: {
                'shop_id': shopId,
            },
            query: {
                'page': page,
                'limit': limit,
                'tags': tags,
                'keyword': keyword,
                'fields': fields,
                'published': published,
                'sort_by': sortBy,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static deleteApi({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Array<Page>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}',
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
    public static getApi1({
shopId,
idOrSlug,
}: {
shopId: string,
idOrSlug: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/{IdOrSlug}',
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
    public static getApiTags({
shopId,
}: {
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/tags',
            path: {
                'shop_id': shopId,
            },
        });
    }

}
