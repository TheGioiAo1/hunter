/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Lencam_Order_Service_Models_LencamOrder_Discount } from '../models/Lencam_Order_Service_Models_LencamOrder_Discount';
import type { Lencam_Order_Service_Models_LencamOrder_DiscountFilter } from '../models/Lencam_Order_Service_Models_LencamOrder_DiscountFilter';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class DiscountService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiDiscount({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_Discount,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/discount',
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
    public static getApiDiscount({
shopId,
fields,
keyword,
page = 1,
limit = 10,
status,
isAuto,
startDate,
endDate,
}: {
shopId: string,
fields?: string,
keyword?: string,
page?: number,
limit?: number,
status?: boolean,
isAuto?: boolean,
startDate?: string,
endDate?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/discount',
            path: {
                'shop_id': shopId,
            },
            query: {
                'fields': fields,
                'keyword': keyword,
                'page': page,
                'limit': limit,
                'status': status,
                'IsAuto': isAuto,
                'startDate': startDate,
                'endDate': endDate,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static deleteApiDiscount({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/discount',
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
    public static postApiDiscountExport({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_DiscountFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/discount/export',
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
    public static postApiDiscountImport({
shopId,
formData,
}: {
shopId: string,
formData?: {
file?: Blob;
},
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/discount/import',
            path: {
                'shop_id': shopId,
            },
            formData: formData,
            mediaType: 'multipart/form-data',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiDiscount1({
discountId,
shopId,
}: {
discountId: string,
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/discount/{discount_id}',
            path: {
                'discount_id': discountId,
                'shop_id': shopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiDiscount({
shopId,
discountId,
requestBody,
}: {
shopId: string,
discountId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_Discount,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/discount/{discount_id}',
            path: {
                'shop_id': shopId,
                'discount_id': discountId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static deleteApiDiscount1({
discountId,
shopId,
}: {
discountId: string,
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/discount/{discount_id}',
            path: {
                'discount_id': discountId,
                'shop_id': shopId,
            },
        });
    }

}
