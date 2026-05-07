/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Layout } from '../models/Layout';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class LayoutService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getTestCache(): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/TestCache',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getDetail({
shopId,
layoutName,
}: {
shopId: string,
layoutName: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/detail/{shop_id}/{layout_name}',
            path: {
                'shop_id': shopId,
                'layout_name': layoutName,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postCreate({
layoutId,
requestBody,
}: {
layoutId?: string,
requestBody?: Layout,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/create',
            query: {
                'layout_id': layoutId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putUpdate({
layoutId,
requestBody,
}: {
layoutId: string,
requestBody?: Layout,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/update/{layout_id}',
            path: {
                'layout_id': layoutId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static deleteDetele({
layoutId,
}: {
layoutId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/detele/{layout_id}',
            path: {
                'layout_id': layoutId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postCloneLayout({
shopId,
}: {
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/clone-layout/{shop_id}',
            path: {
                'shop_id': shopId,
            },
        });
    }

}
