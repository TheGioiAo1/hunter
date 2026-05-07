/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AppShop } from '../models/AppShop';
import type { Webhook } from '../models/Webhook';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class AppShopService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static deleteApi({
shopId,
appId,
}: {
shopId: string,
appId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/{app_id}',
            path: {
                'shop_id': shopId,
                'app_id': appId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApi({
shopId,
appId,
}: {
shopId: string,
appId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/{app_id}',
            path: {
                'shop_id': shopId,
                'app_id': appId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApi1({
shopId,
page = 1,
limit = 250,
status,
sortBy = 'name_desc',
fields,
}: {
shopId: string,
page?: number,
limit?: number,
status?: boolean,
sortBy?: string,
fields?: string,
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
                'status': status,
                'sort_by': sortBy,
                'fields': fields,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApi({
shopId,
reinstall,
requestBody,
}: {
shopId: string,
reinstall?: string,
requestBody?: AppShop,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}',
            path: {
                'shop_id': shopId,
            },
            query: {
                'reinstall': reinstall,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiRoles({
shopId,
appId,
requestBody,
}: {
shopId: string,
appId?: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/roles',
            path: {
                'shop_id': shopId,
            },
            query: {
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
    public static putApiRefreshToken({
shopId,
appId,
}: {
shopId: string,
appId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/refresh-token/{app_id}',
            path: {
                'shop_id': shopId,
                'app_id': appId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiWebhookReplace({
shopId,
appId,
requestBody,
}: {
shopId: string,
appId: string,
requestBody?: Array<Webhook>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/webhook/replace/{app_id}',
            path: {
                'shop_id': shopId,
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
    public static getApiWebhookList({
appId,
shopId,
}: {
appId: string,
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/webhook/list/{app_id}',
            path: {
                'app_id': appId,
                'shop_id': shopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiWebhook({
shopId,
topic,
secret,
}: {
shopId: string,
topic: string,
secret?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/webhook/{topic}',
            path: {
                'shop_id': shopId,
                'topic': topic,
            },
            query: {
                'secret': secret,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiWebhook({
appId,
shopId,
requestBody,
}: {
appId: string,
shopId: string,
requestBody?: Webhook,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/webhook/{app_id}',
            path: {
                'app_id': appId,
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
    public static putApiWebhook({
appId,
topic,
shopId,
requestBody,
}: {
appId: string,
topic: string,
shopId: string,
requestBody?: Webhook,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/webhook/{app_id}/{topic}',
            path: {
                'app_id': appId,
                'topic': topic,
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
    public static deleteApiWebhook({
appId,
topic,
shopId,
}: {
appId: string,
topic: string,
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/webhook/{app_id}/{topic}',
            path: {
                'app_id': appId,
                'topic': topic,
                'shop_id': shopId,
            },
        });
    }

}
