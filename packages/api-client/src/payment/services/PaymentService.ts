/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Payment } from '../models/Payment';
import type { Paypal } from '../models/Paypal';
import type { Stripe } from '../models/Stripe';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class PaymentService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApi({
shopId,
paymentId,
}: {
shopId: string,
paymentId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/{payment_id}',
            path: {
                'shop_id': shopId,
                'payment_id': paymentId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApi({
shopId,
paymentId,
requestBody,
}: {
shopId: string,
paymentId: string,
requestBody?: Payment,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/{payment_id}',
            path: {
                'shop_id': shopId,
                'payment_id': paymentId,
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
paymentId,
}: {
shopId: string,
paymentId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/{payment_id}',
            path: {
                'shop_id': shopId,
                'payment_id': paymentId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiPublic({
shopId,
}: {
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/public',
            path: {
                'shop_id': shopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApi1({
shopId,
page = 1,
limit = 250,
active,
live,
fields,
}: {
shopId: string,
page?: number,
limit?: number,
active?: boolean,
live?: boolean,
fields?: string,
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
                'active': active,
                'live': live,
                'fields': fields,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApi({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Payment,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
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
    public static putApiPosition({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Array<Payment>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/position',
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
    public static postApiProcessStripe({
shopId,
orderId,
paymentMethodId,
paymentMethodDomain,
requestBody,
}: {
shopId: string,
orderId: string,
paymentMethodId: string,
paymentMethodDomain?: string,
requestBody?: Stripe,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/process/stripe/{order_id}/{payment_method_id}',
            path: {
                'shop_id': shopId,
                'order_id': orderId,
                'payment_method_id': paymentMethodId,
            },
            query: {
                'payment_method_domain': paymentMethodDomain,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiProcessPaypal({
shopId,
orderId,
paymentMethodId,
paymentMethodDomain,
requestBody,
}: {
shopId: string,
orderId: string,
paymentMethodId: string,
paymentMethodDomain?: string,
requestBody?: Paypal,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/process/paypal/{order_id}/{payment_method_id}',
            path: {
                'shop_id': shopId,
                'order_id': orderId,
                'payment_method_id': paymentMethodId,
            },
            query: {
                'payment_method_domain': paymentMethodDomain,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

}
