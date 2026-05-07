/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class GboxOrderServiceService {

    /**
     * @returns string Success
     * @throws ApiError
     */
    public static getSwaggerIndexHtml(): CancelablePromise<string> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/swagger/index.html',
        });
    }

}
