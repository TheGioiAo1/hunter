/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class TestService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiTestTest(): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/Test/test',
        });
    }

    /**
     * @returns string Success
     * @throws ApiError
     */
    public static getApiTest(): CancelablePromise<Array<string>> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/Test',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiTest({
requestBody,
}: {
requestBody?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/Test',
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns string Success
     * @throws ApiError
     */
    public static getApiTestCustomer(): CancelablePromise<Array<string>> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/Test/customer',
        });
    }

    /**
     * @returns string Success
     * @throws ApiError
     */
    public static getApiTest1({
id,
}: {
id: number,
}): CancelablePromise<string> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/Test/{id}',
            path: {
                'id': id,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiTest({
id,
requestBody,
}: {
id: number,
requestBody?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/Test/{id}',
            path: {
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
    public static deleteApiTest({
id,
}: {
id: number,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/Test/{id}',
            path: {
                'id': id,
            },
        });
    }

}
