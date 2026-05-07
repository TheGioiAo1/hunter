/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Menu } from '../models/Menu';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class MenuService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiMenu({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Menu,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/menu',
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
    public static deleteApiMenu({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/menu',
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
    public static getApiMenu({
shopId,
location,
}: {
shopId: string,
location?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/menu',
            path: {
                'shop_id': shopId,
            },
            query: {
                'location': location,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiMenu({
shopId,
menuId,
requestBody,
}: {
shopId: string,
menuId: string,
requestBody?: Menu,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/menu/{menu_id}',
            path: {
                'shop_id': shopId,
                'menu_id': menuId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiMenu1({
shopId,
menuId,
}: {
shopId: string,
menuId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/menu/{menu_id}',
            path: {
                'shop_id': shopId,
                'menu_id': menuId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static deleteApiMenu1({
shopId,
menuId,
}: {
shopId: string,
menuId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/menu/{menu_id}',
            path: {
                'shop_id': shopId,
                'menu_id': menuId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiMenuPosition({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Array<Menu>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/menu/position',
            path: {
                'shop_id': shopId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

}
