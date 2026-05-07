/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class FeedService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiFeed({
shopId,
type,
key,
dynamic = true,
}: {
shopId: string,
type: string,
key?: string,
dynamic?: boolean,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/feed/{type}',
            path: {
                'shop_id': shopId,
                'type': type,
            },
            query: {
                'key': key,
                'dynamic': dynamic,
            },
        });
    }

}
