/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ContactUs } from '../models/ContactUs';
import type { EmailTemplate } from '../models/EmailTemplate';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class EmailService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApi({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: EmailTemplate,
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
fields,
sysNames,
}: {
shopId: string,
fields?: string,
sysNames?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}',
            path: {
                'shop_id': shopId,
            },
            query: {
                'fields': fields,
                'sys_names': sysNames,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApi1({
shopId,
sysName,
}: {
shopId: string,
sysName: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/{sys_name}',
            path: {
                'shop_id': shopId,
                'sys_name': sysName,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiRecover({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/recover',
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
    public static postApiSend({
classify,
shopId,
type,
requestBody,
}: {
classify: string,
shopId: string,
type?: string,
requestBody?: any,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/send/{classify}',
            path: {
                'classify': classify,
                'shop_id': shopId,
            },
            query: {
                'type': type,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiContactUs({
shopId,
shopEmail,
requestBody,
}: {
shopId: string,
shopEmail?: string,
requestBody?: ContactUs,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/contact-us',
            path: {
                'shop_id': shopId,
            },
            query: {
                'shop_email': shopEmail,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiCloneEmail({
shopId,
}: {
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/clone-email',
            path: {
                'shop_id': shopId,
            },
        });
    }

}
