/* generated using openapi-typescript-codegen -- do no edit (Modified by Gemini to return Mock Data) */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Shop } from '../models/Shop';
import { CancelablePromise } from '../core/CancelablePromise';

const MOCK_SHOP: Shop = {
    id: 'mock-shop-id-123',
    name: 'Gbox Mock Store',
    title: 'Gbox Demo Store',
    email: 'contact@mock-gbox.co',
    public_domain: 'demo.gbox.co',
    active: true,
    currency: 'USD',
    create_date: new Date().toISOString()
};

export class ShopService {

    public static getApi({
page = 1,
limit = 250,
}: {
page?: number,
limit?: number,
fields?: string,
published?: boolean,
}): CancelablePromise<any> {
        return new CancelablePromise((resolve) => {
            resolve({
                items: [MOCK_SHOP],
                total: 1
            });
        });
    }

    public static getApi1({
shopId,
}: {
shopId: string,
fields?: string,
}): CancelablePromise<any> {
        return new CancelablePromise((resolve) => {
            resolve({ ...MOCK_SHOP, id: shopId });
        });
    }

    public static putApi({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Shop,
}): CancelablePromise<any> {
        return new CancelablePromise((resolve) => {
            resolve({ ...MOCK_SHOP, ...requestBody, id: shopId });
        });
    }

    public static deleteApi({
shopId,
}: {
shopId: string,
}): CancelablePromise<any> {
        return new CancelablePromise((resolve) => {
            resolve({ status: 'ok', deleted: true, id: shopId });
        });
    }

    public static getApiScript({
shopId,
}: {
shopId: string,
}): CancelablePromise<any> {
        return new CancelablePromise((resolve) => {
            resolve({ shop_id: shopId, scripts: [] });
        });
    }

    public static deleteApiPublicDomain({
shopId,
}: {
shopId: string,
}): CancelablePromise<any> {
        return new CancelablePromise((resolve) => {
            resolve({ status: 'ok', id: shopId });
        });
    }

    public static putApiPublicDomain({
shopId,
domain,
}: {
shopId: string,
domain?: string,
}): CancelablePromise<any> {
        return new CancelablePromise((resolve) => {
            resolve({ status: 'ok', id: shopId, public_domain: domain });
        });
    }

    public static getApiCheckName({
name,
}: {
name?: string,
}): CancelablePromise<any> {
        return new CancelablePromise((resolve) => {
            resolve({ available: true, name });
        });
    }

    public static postApiInit({
name,
}: {
name?: string,
}): CancelablePromise<any> {
        return new CancelablePromise((resolve) => {
            resolve({ ...MOCK_SHOP, name, id: 'new-mock-id' });
        });
    }

    public static putApiRenewShop({
domain,
}: {
domain?: string,
renewDay?: number,
}): CancelablePromise<any> {
        return new CancelablePromise((resolve) => {
            resolve({ status: 'ok', domain });
        });
    }

}
