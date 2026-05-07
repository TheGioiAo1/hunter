/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Customer } from '../models/Customer';
import type { GoogleCredentialObject } from '../models/GoogleCredentialObject';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class GuestService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiGuestTest({
shopId,
}: {
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/guest/test',
            path: {
                'shop_id': shopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiGuestChangePassword({
shopId,
newPassword,
oldPassword,
emailCustomer,
}: {
shopId: string,
newPassword?: string,
oldPassword?: string,
emailCustomer?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/guest/change-password',
            path: {
                'shop_id': shopId,
            },
            query: {
                'new_password': newPassword,
                'old_password': oldPassword,
                'email_customer': emailCustomer,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiGuestUpdate({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Customer,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/guest/update',
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
    public static postApiGuestTestMail({
email,
shopId = '633174eaa143f816d518b7f1',
}: {
email?: string,
shopId?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/guest/test-mail',
            path: {
                'shop_id': shopId,
            },
            query: {
                'email': email,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiGuestSignup({
shopId,
domain,
requestBody,
}: {
shopId: string,
domain?: string,
requestBody?: Customer,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/guest/signup',
            path: {
                'shop_id': shopId,
            },
            query: {
                'domain': domain,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiGuestActive({
shopId,
email,
domain,
token,
}: {
shopId: string,
email?: string,
domain?: string,
token?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/guest/active',
            path: {
                'shop_id': shopId,
            },
            query: {
                'email': email,
                'domain': domain,
                'token': token,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiGuestRecoverPassword({
shopId,
domain,
email,
}: {
shopId: string,
domain?: string,
email?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/guest/recover-password',
            path: {
                'shop_id': shopId,
            },
            query: {
                'domain': domain,
                'email': email,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiGuestRecoverSuccess({
shopId,
email,
token,
domain,
}: {
shopId: string,
email?: string,
token?: string,
domain?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/guest/recover_success',
            path: {
                'shop_id': shopId,
            },
            query: {
                'email': email,
                'token': token,
                'domain': domain,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiGuest({
shopId,
}: {
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/guest',
            path: {
                'shop_id': shopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiGuestAuth({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Customer,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/guest/auth',
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
    public static postApiGuestLoginGoogle({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: GoogleCredentialObject,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/guest/login/google',
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
    public static postApiGuestV1Register({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Customer,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/guest/v1/register',
            path: {
                'shop_id': shopId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

}
