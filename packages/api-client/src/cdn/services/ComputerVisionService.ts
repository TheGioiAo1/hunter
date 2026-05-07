/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Compare } from '../models/Compare';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class ComputerVisionService {

    /**
     * @returns any OK
     * @throws ApiError
     */
    public static postApiComputerVisionCompare({
requestBody,
}: {
requestBody?: Compare,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/computer-vision/compare',
            body: requestBody,
            mediaType: 'application/json',
        });
    }

}
