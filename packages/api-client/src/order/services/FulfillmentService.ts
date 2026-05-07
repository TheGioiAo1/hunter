/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { _17Track_Hook } from '../models/_17Track_Hook';
import type { Lencam_Common_CustomField } from '../models/Lencam_Common_CustomField';
import type { Lencam_Order_Service_Models_LencamOrder_FixAmount } from '../models/Lencam_Order_Service_Models_LencamOrder_FixAmount';
import type { Lencam_Order_Service_Models_LencamOrder_Fulfillment } from '../models/Lencam_Order_Service_Models_LencamOrder_Fulfillment';
import type { Lencam_Order_Service_Models_LencamOrder_FulfillmentFilter } from '../models/Lencam_Order_Service_Models_LencamOrder_FulfillmentFilter';
import type { Lencam_Order_Service_Models_LencamOrder_FulfillmentIO } from '../models/Lencam_Order_Service_Models_LencamOrder_FulfillmentIO';
import type { Lencam_Order_Service_Models_LencamOrder_FulfillmentLineItems } from '../models/Lencam_Order_Service_Models_LencamOrder_FulfillmentLineItems';
import type { Lencam_Order_Service_Models_LencamOrder_FulfillmentLog } from '../models/Lencam_Order_Service_Models_LencamOrder_FulfillmentLog';
import type { Lencam_Order_Service_Models_LencamOrder_PushInfo } from '../models/Lencam_Order_Service_Models_LencamOrder_PushInfo';
import type { Lencam_Order_Service_Models_LencamOrder_Tracking } from '../models/Lencam_Order_Service_Models_LencamOrder_Tracking';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class FulfillmentService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiFulfillmentStopTracking({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/fulfillment/stop-tracking',
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
    public static postApiFulfillmentRefreshTracking({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/fulfillment/refresh-tracking',
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
    public static getApiFulfillmentTrackingTimemetricOverview({
shopId = '633174eaa143f816d518b7f1',
billingId,
fromDate,
toDate,
}: {
shopId?: string,
billingId?: string,
fromDate?: string,
toDate?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/fulfillment/tracking-timemetric-overview',
            path: {
                'shop_id': shopId,
            },
            query: {
                'billing_id': billingId,
                'from_date': fromDate,
                'to_date': toDate,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiFulfillmentTrackingTimemetricOverview({
shopId = '633174eaa143f816d518b7f1',
requestBody,
}: {
shopId?: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_FulfillmentFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/fulfillment/tracking-timemetric-overview',
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
    public static postApiFulfillmentTest({
shopId = '633174eaa143f816d518b7f1',
billingId = '6645cb265e41236034241ced',
fromDate,
toDate,
}: {
shopId?: string,
billingId?: string,
fromDate?: string,
toDate?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/fulfillment/test',
            path: {
                'shop_id': shopId,
            },
            query: {
                'billing_id': billingId,
                'from_date': fromDate,
                'to_date': toDate,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiFulfillmentHook17Track({
secret,
shopId,
requestBody,
}: {
secret: string,
shopId: string,
requestBody?: _17Track_Hook,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/fulfillment/hook/17track/{secret}',
            path: {
                'secret': secret,
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
    public static getApiFulfillmentStatus({
shopId,
}: {
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/fulfillment/status',
            path: {
                'shop_id': shopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiFulfillmentLineitemsTotalBasecost({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_FulfillmentFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/fulfillment/lineitems-total-basecost',
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
    public static postApiFulfillment({
shopId,
page = 1,
limit = 250,
fields,
sortBy = 'create_date_desc',
requestBody,
}: {
shopId: string,
page?: number,
limit?: number,
fields?: string,
sortBy?: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_FulfillmentFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/fulfillment',
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
    public static getApiFulfillment({
shopId,
orderId,
orderShortId,
page = 1,
limit = 250,
keyword,
keywordType,
fields,
shippingStatus,
lineitemStatus,
inventoryId,
fromDate,
toDate,
fromExportedDate,
customFields,
toExportedDate,
sellerId,
exported,
haveTracking,
productIds,
managerId,
shortIds,
sortBy = 'create_date_desc',
lineItemIds,
}: {
shopId: string,
orderId?: string,
orderShortId?: string,
page?: number,
limit?: number,
keyword?: string,
keywordType?: string,
fields?: string,
shippingStatus?: string,
lineitemStatus?: string,
inventoryId?: string,
fromDate?: string,
toDate?: string,
fromExportedDate?: string,
customFields?: string,
toExportedDate?: string,
sellerId?: string,
exported?: string,
haveTracking?: string,
productIds?: string,
managerId?: string,
shortIds?: string,
sortBy?: string,
lineItemIds?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/fulfillment',
            path: {
                'shop_id': shopId,
            },
            query: {
                'order_id': orderId,
                'order_short_id': orderShortId,
                'page': page,
                'limit': limit,
                'keyword': keyword,
                'keywordType': keywordType,
                'fields': fields,
                'shipping_status': shippingStatus,
                'lineitem_status': lineitemStatus,
                'inventory_id': inventoryId,
                'from_date': fromDate,
                'to_date': toDate,
                'from_exported_date': fromExportedDate,
                'customFields': customFields,
                'to_exported_date': toExportedDate,
                'seller_id': sellerId,
                'exported': exported,
                'have_tracking': haveTracking,
                'product_ids': productIds,
                'manager_id': managerId,
                'short_ids': shortIds,
                'sort_by': sortBy,
                'lineItem_ids': lineItemIds,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiFulfillmentPushStatus({
shopId,
fulfillmentId,
requestBody,
}: {
shopId: string,
fulfillmentId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_PushInfo,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/fulfillment/push_status/{fulfillment_id}',
            path: {
                'shop_id': shopId,
                'fulfillment_id': fulfillmentId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiFulfillmentFixAmount({
shopId,
fulfillmentId,
requestBody,
}: {
shopId: string,
fulfillmentId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_FixAmount,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/fulfillment/fix-amount/{fulfillment_id}',
            path: {
                'shop_id': shopId,
                'fulfillment_id': fulfillmentId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiFulfillment1({
shopId,
orderId,
fulfillmentId,
}: {
shopId: string,
orderId: string,
fulfillmentId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/fulfillment/{order_id}/{fulfillment_id}',
            path: {
                'shop_id': shopId,
                'order_id': orderId,
                'fulfillment_id': fulfillmentId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiFulfillment({
shopId,
orderId,
fulfillmentId,
requestBody,
}: {
shopId: string,
orderId: string,
fulfillmentId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_Fulfillment,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/fulfillment/{order_id}/{fulfillment_id}',
            path: {
                'shop_id': shopId,
                'order_id': orderId,
                'fulfillment_id': fulfillmentId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static deleteApiFulfillment({
shopId,
orderId,
fulfillmentId,
}: {
shopId: string,
orderId: string,
fulfillmentId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/fulfillment/{order_id}/{fulfillment_id}',
            path: {
                'shop_id': shopId,
                'order_id': orderId,
                'fulfillment_id': fulfillmentId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiFulfillment2({
shopId,
fulfillmentShortId,
}: {
shopId: string,
fulfillmentShortId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/fulfillment/{fulfillment_short_id}',
            path: {
                'shop_id': shopId,
                'fulfillment_short_id': fulfillmentShortId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiFulfillmentLineitemsStatus({
shopId,
trackingNumber,
status,
}: {
shopId: string,
trackingNumber: string,
status?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/fulfillment/lineitems-status/{tracking_number}',
            path: {
                'shop_id': shopId,
                'tracking_number': trackingNumber,
            },
            query: {
                'status': status,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiFulfillmentLineitemsStatus1({
shopId,
status,
requestBody,
}: {
shopId: string,
status?: string,
requestBody?: Array<Lencam_Order_Service_Models_LencamOrder_FulfillmentLineItems>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/fulfillment/lineitems-status',
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
    public static postApiFulfillment1({
shopId,
orderId,
requestBody,
}: {
shopId: string,
orderId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_Fulfillment,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/fulfillment/{order_id}',
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
    public static putApiFulfillmentRemoveInventoryId({
shopId,
orderId,
fulfillmentId,
}: {
shopId: string,
orderId: string,
fulfillmentId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/fulfillment/{order_id}/remove-inventory-id/{fulfillment_id}',
            path: {
                'shop_id': shopId,
                'order_id': orderId,
                'fulfillment_id': fulfillmentId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiFulfillmentRejectItem({
fulfillmentId,
shopId,
requestBody,
}: {
fulfillmentId: string,
shopId: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/fulfillment/{fulfillment_id}/reject-item',
            path: {
                'fulfillment_id': fulfillmentId,
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
    public static putApiFulfillmentUpdateTracking({
shopId,
fulfillmentId,
requestBody,
}: {
shopId: string,
fulfillmentId?: string,
requestBody?: Array<Lencam_Order_Service_Models_LencamOrder_Tracking>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/fulfillment/update-tracking',
            path: {
                'shop_id': shopId,
            },
            query: {
                'fulfillment_id': fulfillmentId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiFulfillmentInventoryOverview({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_FulfillmentFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/fulfillment/inventory-overview',
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
    public static getApiFulfillmentTrackings({
shopId,
keyword,
keywordType,
trackingStatus,
trackingNumber,
orderShortIds,
fromDate,
toDate,
sortBy = 'create_at_desc',
page = 1,
limit = 50,
}: {
shopId: string,
keyword?: string,
keywordType?: string,
trackingStatus?: string,
trackingNumber?: string,
orderShortIds?: string,
fromDate?: string,
toDate?: string,
sortBy?: string,
page?: number,
limit?: number,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/fulfillment/trackings',
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
                'sort_by': sortBy,
                'page': page,
                'limit': limit,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiFulfillmentCustomfields({
shopId,
id,
requestBody,
}: {
shopId: string,
id: string,
requestBody?: Array<Lencam_Common_CustomField>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/fulfillment/{id}/customfields',
            path: {
                'shop_id': shopId,
                'id': id,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiFulfillmentExport({
shopId,
id,
shortid,
ids,
shortids,
inventoryIds,
exported,
orderId,
orderShortid,
orderShortids,
productId,
productIds,
variantSlug,
lineItemShortids,
lineItemStatus,
keyword,
keywordType,
fromDate,
toDate,
fromExportDate,
toExportDate,
trackingFromDate,
trackingToDate,
selerId,
haveTracking,
trackingStatus,
trackingNumber,
isExcelFile = 'false',
}: {
shopId: string,
id?: string,
shortid?: string,
ids?: string,
shortids?: string,
inventoryIds?: string,
exported?: string,
orderId?: string,
orderShortid?: string,
orderShortids?: string,
productId?: string,
productIds?: string,
variantSlug?: string,
lineItemShortids?: string,
lineItemStatus?: string,
keyword?: string,
keywordType?: string,
fromDate?: string,
toDate?: string,
fromExportDate?: string,
toExportDate?: string,
trackingFromDate?: string,
trackingToDate?: string,
selerId?: string,
haveTracking?: string,
trackingStatus?: string,
trackingNumber?: string,
isExcelFile?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/fulfillment/export',
            path: {
                'shop_id': shopId,
            },
            query: {
                'id': id,
                'shortid': shortid,
                'ids': ids,
                'shortids': shortids,
                'inventory_ids': inventoryIds,
                'exported': exported,
                'order_id': orderId,
                'order_shortid': orderShortid,
                'order_shortids': orderShortids,
                'product_id': productId,
                'product_ids': productIds,
                'variant_slug': variantSlug,
                'line_item_shortids': lineItemShortids,
                'line_item_status': lineItemStatus,
                'keyword': keyword,
                'keyword_type': keywordType,
                'from_date': fromDate,
                'to_date': toDate,
                'from_export_date': fromExportDate,
                'to_export_date': toExportDate,
                'tracking_from_date': trackingFromDate,
                'tracking_to_date': trackingToDate,
                'seler_id': selerId,
                'have_tracking': haveTracking,
                'tracking_status': trackingStatus,
                'tracking_number': trackingNumber,
                'is_excel_file': isExcelFile,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiFulfillmentExport({
shopId,
page = 1,
limit = -1,
requestBody,
}: {
shopId: string,
page?: number,
limit?: number,
requestBody?: Lencam_Order_Service_Models_LencamOrder_FulfillmentFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/fulfillment/export',
            path: {
                'shop_id': shopId,
            },
            query: {
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
    public static getApiFulfillmentTrackingSatisticsTotal({
shopId,
selerId,
managerId,
fromDate,
toDate,
trackingFromDate,
trackingToDate,
inventoryId,
}: {
shopId: string,
selerId?: string,
managerId?: string,
fromDate?: string,
toDate?: string,
trackingFromDate?: string,
trackingToDate?: string,
inventoryId?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/fulfillment/tracking_satistics_total',
            path: {
                'shop_id': shopId,
            },
            query: {
                'seler_id': selerId,
                'manager_id': managerId,
                'from_date': fromDate,
                'to_date': toDate,
                'tracking_from_date': trackingFromDate,
                'tracking_to_date': trackingToDate,
                'inventory_id': inventoryId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiFulfillmentTrackingSatisticsTotal({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_FulfillmentFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/fulfillment/tracking_satistics_total',
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
    public static getApiFulfillmentTrackingSatistics({
shopId,
selerId,
managerId,
fromDate,
toDate,
trackingFromDate,
trackingToDate,
inventoryId,
}: {
shopId: string,
selerId?: string,
managerId?: string,
fromDate?: string,
toDate?: string,
trackingFromDate?: string,
trackingToDate?: string,
inventoryId?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/fulfillment/tracking_satistics',
            path: {
                'shop_id': shopId,
            },
            query: {
                'seler_id': selerId,
                'manager_id': managerId,
                'from_date': fromDate,
                'to_date': toDate,
                'tracking_from_date': trackingFromDate,
                'tracking_to_date': trackingToDate,
                'inventory_id': inventoryId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiFulfillmentCheckNoTracking({
shopId,
selerId,
managerId,
fromDate,
toDate,
inventoryId,
}: {
shopId: string,
selerId?: string,
managerId?: string,
fromDate?: string,
toDate?: string,
inventoryId?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/fulfillment/check_no_tracking',
            path: {
                'shop_id': shopId,
            },
            query: {
                'seler_id': selerId,
                'manager_id': managerId,
                'from_date': fromDate,
                'to_date': toDate,
                'inventory_id': inventoryId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiFulfillmentItemBaseCost({
shopId,
itemShortId,
totalBaseCost,
fulfillmentShortId,
}: {
shopId: string,
itemShortId: string,
totalBaseCost?: number,
fulfillmentShortId?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/fulfillment/item-base-cost/{item_short_id}',
            path: {
                'shop_id': shopId,
                'item_short_id': itemShortId,
            },
            query: {
                'total_base_cost': totalBaseCost,
                'fulfillment_short_id': fulfillmentShortId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiFulfillmentTracking({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_FulfillmentIO,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/fulfillment/tracking',
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
    public static putApiFulfillmentNote({
shopId,
fulfillmentId,
itemId,
requestBody,
}: {
shopId: string,
fulfillmentId: string,
itemId: string,
requestBody?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/fulfillment/{fulfillment_id}/note/{item_id}',
            path: {
                'shop_id': shopId,
                'fulfillment_id': fulfillmentId,
                'item_id': itemId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiFulfillmentOrverview({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_FulfillmentFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/fulfillment/orverview',
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
    public static postApiFulfillmentFulfillmentSatisticsLeadtime({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_FulfillmentFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/fulfillment/fulfillment_satistics_leadtime',
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
    public static postApiFulfillmentLogs({
shopId,
fulfillmentId,
requestBody,
}: {
shopId: string,
fulfillmentId: string,
requestBody?: Lencam_Order_Service_Models_LencamOrder_FulfillmentLog,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/fulfillment/logs/{fulfillment_id}',
            path: {
                'shop_id': shopId,
                'fulfillment_id': fulfillmentId,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiFulfillmentLogs({
shopId,
fulfillmentId,
page = 1,
limit = 250,
fields,
sortBy = 'create_date_asc',
}: {
shopId: string,
fulfillmentId: string,
page?: number,
limit?: number,
fields?: string,
sortBy?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/fulfillment/logs/{fulfillment_id}',
            path: {
                'shop_id': shopId,
                'fulfillment_id': fulfillmentId,
            },
            query: {
                'page': page,
                'limit': limit,
                'fields': fields,
                'sort_by': sortBy,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiFulfillmentTotalTransaction({
fulfillmentId,
shopId,
totalTransaction,
}: {
fulfillmentId: string,
shopId: string,
totalTransaction?: number,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/fulfillment/total-transaction/{fulfillment_id}',
            path: {
                'fulfillment_id': fulfillmentId,
                'shop_id': shopId,
            },
            query: {
                'total_transaction': totalTransaction,
            },
        });
    }

}
