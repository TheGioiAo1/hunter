/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Review } from '../models/Review';
import type { Status } from '../models/Status';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class ReviewService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiReview({
shopId,
rating,
type,
status,
categoryIds,
productIds,
keyword,
page = 1,
limit = 250,
sortBy,
fields,
}: {
shopId: string,
rating?: number,
type?: number,
status?: number,
categoryIds?: string,
productIds?: string,
keyword?: string,
page?: number,
limit?: number,
sortBy?: string,
fields?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/review',
            path: {
                'shop_id': shopId,
            },
            query: {
                'rating': rating,
                'type': type,
                'status': status,
                'category_ids': categoryIds,
                'product_ids': productIds,
                'keyword': keyword,
                'page': page,
                'limit': limit,
                'sort_by': sortBy,
                'fields': fields,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiReview({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Review,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/review',
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
    public static deleteApiReview({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/review',
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
    public static getApiReview1({
shopId,
reviewId,
}: {
shopId: string,
reviewId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/review/{review_id}',
            path: {
                'shop_id': shopId,
                'review_id': reviewId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiReview({
shopId,
reviewId,
requestBody,
}: {
shopId: string,
reviewId: string,
requestBody?: Review,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/review/{review_id}',
            path: {
                'shop_id': shopId,
                'review_id': reviewId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static deleteApiReview1({
shopId,
reviewId,
}: {
shopId: string,
reviewId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/review/{review_id}',
            path: {
                'shop_id': shopId,
                'review_id': reviewId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiReviewApprove({
shopId,
status,
requestBody,
}: {
shopId: string,
status?: Status,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/review/approve',
            path: {
                'shop_id': shopId,
            },
            query: {
                'status': status,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

}
