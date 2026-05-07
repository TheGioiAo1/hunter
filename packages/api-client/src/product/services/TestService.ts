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
    public static getApiTest(): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/test',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiTestRestoreImgAmz({
imgUrl,
}: {
imgUrl?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/test/restore-img-amz',
            query: {
                'imgUrl': imgUrl,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiTestImage({
url = 'https://cdn.shopify.com/s/files/1/0017/1507/7177/products/lagoon_1000x1000.jpg',
}: {
url?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/test/image',
            query: {
                'url': url,
            },
        });
    }

}
