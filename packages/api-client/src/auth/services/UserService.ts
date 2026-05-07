/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { User } from '../models/User';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class UserService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiUserMe(): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/user/me',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiUserValidate({
email,
}: {
email: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/user/validate/{email}',
            path: {
                'email': email,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiUserSignup({
requestBody,
}: {
requestBody?: User,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/user/signup',
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiUserResendActive({
email,
}: {
email: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/user/resend-active/{email}',
            path: {
                'email': email,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiUser({
requestBody,
}: {
requestBody?: User,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/user',
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiUserActive({
email,
accessKey,
}: {
email: string,
accessKey: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/user/active/{email}/{access_key}',
            path: {
                'email': email,
                'access_key': accessKey,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiUserChangePassword({
oldPass,
newPass,
}: {
oldPass?: string,
newPass?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/user/change-password',
            query: {
                'old_pass': oldPass,
                'new_pass': newPass,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiUserChangeEmail({
newEmail,
password,
}: {
newEmail?: string,
password?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/user/change-email',
            query: {
                'new_email': newEmail,
                'password': password,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiUserRecover({
email,
}: {
email: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/user/recover/{email}',
            path: {
                'email': email,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiUserResetPassword({
accessKey,
}: {
accessKey: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/user/reset-password/{access_key}',
            path: {
                'access_key': accessKey,
            },
        });
    }

}
