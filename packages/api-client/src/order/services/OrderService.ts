/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Lencam_Common_CustomField } from '../models/Lencam_Common_CustomField';
import type { Lencam_Order_Service_Models_LencamOrder_Customer } from '../models/Lencam_Order_Service_Models_LencamOrder_Customer';
import type { Lencam_Order_Service_Models_LencamOrder_Order } from '../models/Lencam_Order_Service_Models_LencamOrder_Order';
import type { Lencam_Order_Service_Models_LencamOrder_OrderFilter } from '../models/Lencam_Order_Service_Models_LencamOrder_OrderFilter';
import type { Lencam_Order_Service_Models_LencamOrder_OrderLineItemRequest } from '../models/Lencam_Order_Service_Models_LencamOrder_OrderLineItemRequest';
import type { Lencam_Order_Service_Models_LencamOrder_OrderLineItems } from '../models/Lencam_Order_Service_Models_LencamOrder_OrderLineItems';
import type { Lencam_Order_Service_Models_LencamOrder_OrderLog } from '../models/Lencam_Order_Service_Models_LencamOrder_OrderLog';
import type { Lencam_Order_Service_Models_LencamOrder_VerifyAddress } from '../models/Lencam_Order_Service_Models_LencamOrder_VerifyAddress';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class OrderService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiGetOrderNumbersExits({
shopId,
storeId,
requestBody,
}: {
shopId: string,
storeId?: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/get-order-numbers-exits',
            path: {
                'shop_id': shopId,
            },
            query: {
                'store_id': storeId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiInsertTemp({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_Order,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/insert-temp',
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
    public static postApiProductAnalysis({
shopId,
fromDate,
toDate,
page = 1,
limit = 250,
sortBy = 'count_desc',
}: {
shopId: string,
fromDate?: string,
toDate?: string,
page?: number,
limit?: number,
sortBy?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/product-analysis',
            path: {
                'shop_id': shopId,
            },
            query: {
                'from_date': fromDate,
                'to_date': toDate,
                'page': page,
                'limit': limit,
                'sort_by': sortBy,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiCount({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_OrderFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/count',
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
    public static postApiList({
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
            url: '/api/{shop_id}/list',
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
    public static putApiVerified({
orderId,
shopId,
requestBody,
}: {
orderId: string,
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_VerifyAddress,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/verified/{order_id}',
            path: {
                'order_id': orderId,
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
    public static postApiReviewOrderBuyer({
shopId,
isStaff = false,
requestBody,
}: {
shopId: string,
isStaff?: boolean,
requestBody?: Lencam_Order_Service_Models_LencamOrder_OrderFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/review-order-buyer',
            path: {
                'shop_id': shopId,
            },
            query: {
                'isStaff': isStaff,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiReviewOrderStaffBuyer({
shopId,
billingId,
fromDate,
toDate,
page = 1,
limit = 250,
requestBody,
}: {
shopId: string,
billingId?: string,
fromDate?: string,
toDate?: string,
page?: number,
limit?: number,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/review-order-staff-buyer',
            path: {
                'shop_id': shopId,
            },
            query: {
                'billing_id': billingId,
                'from_date': fromDate,
                'to_date': toDate,
                'page': page,
                'limit': limit,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiReviewOrderManager({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_OrderFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/review-order-manager',
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
    public static getApi({
shopId,
page = 1,
limit = 250,
status,
fields,
keyword,
keywordType,
fromDate,
toDate,
productIds,
sortBy = 'price_asc',
tags,
paymentStatus,
lineItemStatus,
lineItemShortIds,
lineItemIds,
managerIds,
customFields,
lineItemCf,
customerId,
customerEmail,
fieldExists,
ids,
countryCode,
orderNumbers,
haveFulfillments,
haveItems,
lineItemExists,
lineItemCfExists,
inventoryIds,
shortIds,
}: {
shopId: string,
page?: number,
limit?: number,
status?: string,
fields?: string,
keyword?: string,
keywordType?: string,
fromDate?: string,
toDate?: string,
productIds?: string,
sortBy?: string,
tags?: string,
paymentStatus?: string,
lineItemStatus?: string,
lineItemShortIds?: string,
lineItemIds?: string,
managerIds?: string,
customFields?: string,
lineItemCf?: string,
customerId?: string,
customerEmail?: string,
fieldExists?: string,
ids?: string,
countryCode?: string,
orderNumbers?: string,
haveFulfillments?: string,
haveItems?: string,
lineItemExists?: string,
lineItemCfExists?: string,
inventoryIds?: string,
shortIds?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}',
            path: {
                'shop_id': shopId,
            },
            query: {
                'page': page,
                'limit': limit,
                'status': status,
                'fields': fields,
                'keyword': keyword,
                'keywordType': keywordType,
                'from_date': fromDate,
                'to_date': toDate,
                'product_ids': productIds,
                'sort_by': sortBy,
                'tags': tags,
                'payment_status': paymentStatus,
                'line_item_status': lineItemStatus,
                'line_item_short_ids': lineItemShortIds,
                'line_item_ids': lineItemIds,
                'manager_ids': managerIds,
                'custom_fields': customFields,
                'line_item_cf': lineItemCf,
                'customer_id': customerId,
                'customer_email': customerEmail,
                'field_exists': fieldExists,
                'ids': ids,
                'country_code': countryCode,
                'order_numbers': orderNumbers,
                'have_fulfillments': haveFulfillments,
                'have_items': haveItems,
                'line_item_exists': lineItemExists,
                'line_item_cf_exists': lineItemCfExists,
                'inventory_ids': inventoryIds,
                'short_ids': shortIds,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApi({
shopId,
discount,
isAddCustomer = true,
requestBody,
}: {
shopId: string,
discount?: string,
isAddCustomer?: boolean,
requestBody?: Lencam_Order_Service_Models_LencamOrder_Order,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}',
            path: {
                'shop_id': shopId,
            },
            query: {
                'discount': discount,
                'isAddCustomer': isAddCustomer,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static deleteApi({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}',
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
    public static getApi1({
orderId,
shopId,
}: {
orderId: string,
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/{order_id}',
            path: {
                'order_id': orderId,
                'shop_id': shopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApi({
shopId,
orderId,
discount,
requestBody,
}: {
shopId: string,
orderId: string,
discount?: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_Order,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/{order_id}',
            path: {
                'shop_id': shopId,
                'order_id': orderId,
            },
            query: {
                'discount': discount,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static deleteApi1({
shopId,
orderId,
}: {
shopId: string,
orderId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/{order_id}',
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
    public static getApiTracking({
shopId,
orderNumber,
}: {
shopId: string,
orderNumber: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/{order_number}/tracking',
            path: {
                'shop_id': shopId,
                'order_number': orderNumber,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiPreview({
shopId,
discount,
requestBody,
}: {
shopId: string,
discount?: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_Order,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/preview',
            path: {
                'shop_id': shopId,
            },
            query: {
                'discount': discount,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiPreviewV2({
shopId,
discount,
requestBody,
}: {
shopId: string,
discount?: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_Order,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/preview-v2',
            path: {
                'shop_id': shopId,
            },
            query: {
                'discount': discount,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiLineitemsNote({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_OrderLineItemRequest,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/lineitems-note',
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
    public static putApiLineitemsStatus({
shopId,
status,
requestBody,
}: {
shopId: string,
status?: string,
requestBody?: Array<Lencam_Order_Service_Models_LencamOrder_OrderLineItems>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/lineitems-status',
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

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiLineitemsCustomfield({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_OrderLineItemRequest,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/lineitems-customfield',
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
    public static putApiCustomfield({
shopId,
orderId,
requestBody,
}: {
shopId: string,
orderId?: string,
requestBody?: Lencam_Common_CustomField,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/customfield',
            path: {
                'shop_id': shopId,
            },
            query: {
                'order_id': orderId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiCustomfields({
shopId,
orderId,
requestBody,
}: {
shopId: string,
orderId?: string,
requestBody?: Array<Lencam_Common_CustomField>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/customfields',
            path: {
                'shop_id': shopId,
            },
            query: {
                'order_id': orderId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiBillingAddress({
shopId,
customerId,
requestBody,
}: {
shopId: string,
customerId?: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_Customer,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/billing-address',
            path: {
                'shop_id': shopId,
            },
            query: {
                'customer_id': customerId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiStatus({
shopId,
status,
requestBody,
}: {
shopId: string,
status?: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/status',
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

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiStatus({
shopId,
}: {
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/status',
            path: {
                'shop_id': shopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiBillingAddress1({
orderId,
shopId,
requestBody,
}: {
orderId: string,
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_Customer,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/billing-address/{order_id}',
            path: {
                'order_id': orderId,
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
    public static putApiShippingAddress({
shopId,
orderId,
requestBody,
}: {
shopId: string,
orderId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_Customer,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/shipping-address/{order_id}',
            path: {
                'shop_id': shopId,
                'order_id': orderId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiPaymentMethod({
shopId,
orderId,
totalTransaction,
requestBody,
}: {
shopId: string,
orderId: string,
totalTransaction?: number,
requestBody?: Lencam_Order_Service_Models_LencamOrder_Order,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/payment-method/{order_id}',
            path: {
                'shop_id': shopId,
                'order_id': orderId,
            },
            query: {
                'total_transaction': totalTransaction,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiTags({
shopId,
}: {
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/tags',
            path: {
                'shop_id': shopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiAnalysis({
shopId,
fromDate,
toDate,
requestBody,
}: {
shopId: string,
fromDate?: string,
toDate?: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/analysis',
            path: {
                'shop_id': shopId,
            },
            query: {
                'from_date': fromDate,
                'to_date': toDate,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiListAnalysis({
shopId,
customerId,
fromDate,
toDate,
managerIds,
}: {
shopId: string,
customerId?: string,
fromDate?: string,
toDate?: string,
managerIds?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/list_analysis',
            path: {
                'shop_id': shopId,
            },
            query: {
                'customer_id': customerId,
                'from_date': fromDate,
                'to_date': toDate,
                'manager_ids': managerIds,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiListAnalysis({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_OrderFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/list_analysis',
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
    public static postApiSendMailAbandoned({
shopId,
orderId,
emailSysname = 'abandoned_checkouts',
}: {
shopId: string,
orderId: string,
emailSysname?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/send-mail-abandoned/{order_id}/{email_sysname}',
            path: {
                'shop_id': shopId,
                'order_id': orderId,
                'email_sysname': emailSysname,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiLogs({
shopId,
orderId,
}: {
shopId: string,
orderId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/logs/{order_id}',
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
    public static postApiLogs({
shopId,
orderId,
requestBody,
}: {
shopId: string,
orderId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_OrderLog,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/logs/{order_id}',
            path: {
                'shop_id': shopId,
                'order_id': orderId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiFulfillments({
shopId,
page = 1,
limit = 250,
keyword,
orderNumbers,
fromDate,
managerIds,
countryCode,
toDate,
sortBy = 'id_desc',
}: {
shopId: string,
page?: number,
limit?: number,
keyword?: string,
orderNumbers?: string,
fromDate?: string,
managerIds?: string,
countryCode?: string,
toDate?: string,
sortBy?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/fulfillments',
            path: {
                'shop_id': shopId,
            },
            query: {
                'page': page,
                'limit': limit,
                'keyword': keyword,
                'order_numbers': orderNumbers,
                'from_date': fromDate,
                'manager_ids': managerIds,
                'country_code': countryCode,
                'to_date': toDate,
                'sort_by': sortBy,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiLineItemStatisticStatus({
shopId,
managerIds,
email,
fromDate,
toDate,
}: {
shopId: string,
managerIds?: string,
email?: string,
fromDate?: string,
toDate?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/line-item/statistic/status',
            path: {
                'shop_id': shopId,
            },
            query: {
                'manager_ids': managerIds,
                'email': email,
                'from_date': fromDate,
                'to_date': toDate,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiTotalTransaction({
orderId,
shopId,
totalTransaction,
}: {
orderId: string,
shopId: string,
totalTransaction?: number,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/total-transaction/{order_id}',
            path: {
                'order_id': orderId,
                'shop_id': shopId,
            },
            query: {
                'total_transaction': totalTransaction,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiNote({
shopId,
orderId,
itemId,
requestBody,
}: {
shopId: string,
orderId: string,
itemId: string,
requestBody?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/{order_id}/note/{item_id}',
            path: {
                'shop_id': shopId,
                'order_id': orderId,
                'item_id': itemId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

}
