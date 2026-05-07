/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class CdnService {

    /**
     * @returns any OK
     * @throws ApiError
     */
    public static getRecoveryAmzFile({
url,
}: {
url?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/recovery-amz-file',
            query: {
                'url': url,
            },
        });
    }

    /**
     * @returns any OK
     * @throws ApiError
     */
    public static getBarcode({
path,
}: {
path?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/barcode',
            query: {
                'path': path,
            },
        });
    }

    /**
     * @returns any OK
     * @throws ApiError
     */
    public static getThumb({
path,
width = 50,
}: {
path?: string,
width?: number,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/thumb',
            query: {
                'path': path,
                'width': width,
            },
        });
    }

}
