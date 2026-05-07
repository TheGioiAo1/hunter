/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Lencam_Order_Service_Models_LencamOrder_FulfillmentFilter } from '../models/Lencam_Order_Service_Models_LencamOrder_FulfillmentFilter';
import type { Lencam_Order_Service_Models_LencamOrder_OrderFilter } from '../models/Lencam_Order_Service_Models_LencamOrder_OrderFilter';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class CustomerService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiCustomerDebts({
shopId,
}: {
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/customer/debts',
            path: {
                'shop_id': shopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiCustomerOrderLogs({
shopId,
orderId,
page = 1,
limit = 250,
fields,
}: {
shopId: string,
orderId: string,
page?: number,
limit?: number,
fields?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/customer/order/logs/{order_id}',
            path: {
                'shop_id': shopId,
                'order_id': orderId,
            },
            query: {
                'page': page,
                'limit': limit,
                'fields': fields,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiCustomerSearch({
shopId,
page = 1,
limit = 250,
customFields,
customSearch,
}: {
shopId: string,
page?: number,
limit?: number,
customFields?: string,
customSearch?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/customer/search',
            path: {
                'shop_id': shopId,
            },
            query: {
                'page': page,
                'limit': limit,
                'custom_fields': customFields,
                'custom_search': customSearch,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiCustomerOrder({
shopId,
orderId,
}: {
shopId: string,
orderId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/customer/order/{order_id}',
            path: {
                'shop_id': shopId,
                'order_id': orderId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiCustomerOrderList({
shopId,
page = 1,
limit = 250,
fields,
sortBy = 'price_asc',
requestBody,
}: {
shopId: string,
page?: number,
limit?: number,
fields?: string,
sortBy?: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_OrderFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/customer/order/list',
            path: {
                'shop_id': shopId,
            },
            query: {
                'page': page,
                'limit': limit,
                'fields': fields,
                'sort_by': sortBy,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiCustomerOrder1({
shopId,
page = 1,
limit = 250,
keyword,
keywordType,
fromDate,
toDate,
shortIds,
productIds,
ids,
customFields,
fields,
status,
haveItems,
sortBy,
lineItemExists,
paymentStatus,
countryCode,
lineItemCfExists,
tags,
}: {
shopId: string,
page?: number,
limit?: number,
keyword?: string,
keywordType?: string,
fromDate?: string,
toDate?: string,
shortIds?: string,
productIds?: string,
ids?: string,
customFields?: string,
fields?: string,
status?: string,
haveItems?: string,
sortBy?: string,
lineItemExists?: string,
paymentStatus?: string,
countryCode?: string,
lineItemCfExists?: string,
tags?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/customer/order',
            path: {
                'shop_id': shopId,
            },
            query: {
                'page': page,
                'limit': limit,
                'keyword': keyword,
                'keywordType': keywordType,
                'from_date': fromDate,
                'to_date': toDate,
                'short_ids': shortIds,
                'product_ids': productIds,
                'ids': ids,
                'custom_fields': customFields,
                'fields': fields,
                'status': status,
                'have_items': haveItems,
                'sort_by': sortBy,
                'line_item_exists': lineItemExists,
                'payment_status': paymentStatus,
                'country_code': countryCode,
                'line_item_cf_exists': lineItemCfExists,
                'tags': tags,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static deleteApiCustomerOrder({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/customer/order',
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
    public static postApiCustomerOrderSummary({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_OrderFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/customer/order/summary',
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
    public static getApiCustomerOrderSummary({
shopId,
keyword,
fromDate,
toDate,
shortIds,
productIds,
ids,
customFields,
status,
countryCode,
tags,
customerId,
lineItemStatus,
orderNumbers,
lineItemExists,
lineItemCfExists,
paymentStatus,
haveItems,
managerIds,
}: {
shopId: string,
keyword?: string,
fromDate?: string,
toDate?: string,
shortIds?: string,
productIds?: string,
ids?: string,
customFields?: string,
status?: string,
countryCode?: string,
tags?: string,
customerId?: string,
lineItemStatus?: string,
orderNumbers?: string,
lineItemExists?: string,
lineItemCfExists?: string,
paymentStatus?: string,
haveItems?: string,
managerIds?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/customer/order/summary',
            path: {
                'shop_id': shopId,
            },
            query: {
                'keyword': keyword,
                'from_date': fromDate,
                'to_date': toDate,
                'short_ids': shortIds,
                'product_ids': productIds,
                'ids': ids,
                'custom_fields': customFields,
                'status': status,
                'country_code': countryCode,
                'tags': tags,
                'customer_id': customerId,
                'line_item_status': lineItemStatus,
                'order_numbers': orderNumbers,
                'line_item_exists': lineItemExists,
                'line_item_cf_exists': lineItemCfExists,
                'payment_status': paymentStatus,
                'have_items': haveItems,
                'manager_ids': managerIds,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiCustomerOrderAnalysis({
shopId,
fromDate,
toDate,
}: {
shopId: string,
fromDate?: string,
toDate?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/customer/order/analysis',
            path: {
                'shop_id': shopId,
            },
            query: {
                'from_date': fromDate,
                'to_date': toDate,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiCustomerOrderAnalysis({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_OrderFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/customer/order/analysis',
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
    public static getApiCustomerTracking({
shopId,
trackingNumber,
}: {
shopId: string,
trackingNumber: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/customer/tracking/{tracking_number}',
            path: {
                'shop_id': shopId,
                'tracking_number': trackingNumber,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiCustomerListTrackings({
shopId,
page = 1,
limit = 250,
sortBy = 'create_at_desc',
requestBody,
}: {
shopId: string,
page?: number,
limit?: number,
sortBy?: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_FulfillmentFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/customer/list/trackings',
            path: {
                'shop_id': shopId,
            },
            query: {
                'page': page,
                'limit': limit,
                'sort_by': sortBy,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiCustomerTrackings({
shopId,
keyword,
keywordType,
trackingStatus,
trackingNumber,
orderShortIds,
fromDate,
toDate,
fromTrackUpdate,
toTrackUpdate,
sortBy = 'create_at_desc',
page = 1,
limit = 50,
trackingNotWorking = 'false',
trackingNotWorkingDay = 5,
sellerId,
storeIds,
}: {
shopId: string,
keyword?: string,
keywordType?: string,
trackingStatus?: string,
trackingNumber?: string,
orderShortIds?: string,
fromDate?: string,
toDate?: string,
fromTrackUpdate?: string,
toTrackUpdate?: string,
sortBy?: string,
page?: number,
limit?: number,
trackingNotWorking?: string,
trackingNotWorkingDay?: number,
sellerId?: string,
storeIds?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/customer/trackings',
            path: {
                'shop_id': shopId,
            },
            query: {
                'keyword': keyword,
                'keyword_type': keywordType,
                'tracking_status': trackingStatus,
                'tracking_number': trackingNumber,
                'order_short_ids': orderShortIds,
                'from_date': fromDate,
                'to_date': toDate,
                'from_track_update': fromTrackUpdate,
                'to_track_update': toTrackUpdate,
                'sort_by': sortBy,
                'page': page,
                'limit': limit,
                'tracking_not_working': trackingNotWorking,
                'tracking_not_working_day': trackingNotWorkingDay,
                'seller_id': sellerId,
                'store_ids': storeIds,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiCustomerTrackingMgr({
shopId,
keyword,
keywordType,
trackingStatus,
trackingNumbers,
orderShortIds,
fromDate,
toDate,
page = 1,
limit = 50,
sortBy = 'id_desc',
sellerId,
}: {
shopId: string,
keyword?: string,
keywordType?: string,
trackingStatus?: string,
trackingNumbers?: string,
orderShortIds?: string,
fromDate?: string,
toDate?: string,
page?: number,
limit?: number,
sortBy?: string,
sellerId?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/customer/tracking_mgr',
            path: {
                'shop_id': shopId,
            },
            query: {
                'keyword': keyword,
                'keyword_type': keywordType,
                'tracking_status': trackingStatus,
                'tracking_numbers': trackingNumbers,
                'order_short_ids': orderShortIds,
                'from_date': fromDate,
                'to_date': toDate,
                'page': page,
                'limit': limit,
                'sort_by': sortBy,
                'seller_id': sellerId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiCustomerTags({
shopId,
page = 1,
limit = 50,
keyword,
shortIds,
fromDate,
toDate,
trackingStatus,
customFields,
}: {
shopId: string,
page?: number,
limit?: number,
keyword?: string,
shortIds?: string,
fromDate?: string,
toDate?: string,
trackingStatus?: string,
customFields?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/customer/tags',
            path: {
                'shop_id': shopId,
            },
            query: {
                'page': page,
                'limit': limit,
                'keyword': keyword,
                'short_ids': shortIds,
                'from_date': fromDate,
                'to_date': toDate,
                'tracking_status': trackingStatus,
                'custom_fields': customFields,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiCustomerTrackingSummary({
shopId,
keyword,
orderNumbers,
fromDate,
toDate,
trackingStatus,
customFields,
}: {
shopId: string,
keyword?: string,
orderNumbers?: string,
fromDate?: string,
toDate?: string,
trackingStatus?: string,
customFields?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/customer/tracking/summary',
            path: {
                'shop_id': shopId,
            },
            query: {
                'keyword': keyword,
                'order_numbers': orderNumbers,
                'from_date': fromDate,
                'to_date': toDate,
                'tracking_status': trackingStatus,
                'custom_fields': customFields,
            },
        });
    }

}
