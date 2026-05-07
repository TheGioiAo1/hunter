/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class CrawlService {

    /**
     * @returns any OK
     * @throws ApiError
     */
    public static postApiCrawlExtract({
domain,
}: {
domain?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/crawl/extract',
            query: {
                'domain': domain,
            },
        });
    }

}
