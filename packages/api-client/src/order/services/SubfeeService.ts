/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Lencam_Order_Service_Models_LencamOrder_CartItem } from '../models/Lencam_Order_Service_Models_LencamOrder_CartItem';
import type { Lencam_Order_Service_Models_LencamOrder_SubFee } from '../models/Lencam_Order_Service_Models_LencamOrder_SubFee';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class SubfeeService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiSubfee({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_SubFee,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/subfee',
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
    public static deleteApiSubfee({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/subfee',
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
    public static getApiSubfee({
shopId,
countryCode,
page = 1,
limit = 10,
}: {
shopId: string,
countryCode?: string,
page?: number,
limit?: number,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/subfee',
            path: {
                'shop_id': shopId,
            },
            query: {
                'country_code': countryCode,
                'page': page,
                'limit': limit,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiSubfee({
subfeeId,
shopId,
requestBody,
}: {
subfeeId: string,
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_SubFee,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/subfee/{subfee_id}',
            path: {
                'subfee_id': subfeeId,
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
    public static getApiSubfee1({
subfeeId,
shopId,
}: {
subfeeId: string,
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/subfee/{subfee_id}',
            path: {
                'subfee_id': subfeeId,
                'shop_id': shopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static deleteApiSubfee1({
subfeeId,
shopId,
}: {
subfeeId: string,
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/subfee/{subfee_id}',
            path: {
                'subfee_id': subfeeId,
                'shop_id': shopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiSubfeeCheckout({
shopId,
countryCode,
requestBody,
}: {
shopId: string,
countryCode?: string,
requestBody?: Array<Lencam_Order_Service_Models_LencamOrder_CartItem>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/subfee/checkout',
            path: {
                'shop_id': shopId,
            },
            query: {
                'country_code': countryCode,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

}
