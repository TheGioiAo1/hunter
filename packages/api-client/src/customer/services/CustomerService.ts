/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Customer } from '../models/Customer';
import type { CustomerFilter } from '../models/CustomerFilter';
import type { CustomerManager } from '../models/CustomerManager';
import type { CustomField } from '../models/CustomField';
import type { GoogleSheetItem } from '../models/GoogleSheetItem';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class CustomerService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiExport({
shopId,
}: {
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/export',
            path: {
                'shop_id': shopId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiAddManager({
id,
shopId,
requestBody,
}: {
id: string,
shopId: string,
requestBody?: Array<CustomerManager>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/add-manager/{id}',
            path: {
                'id': id,
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
    public static postApiRemoveManager({
id,
shopId,
managerId,
}: {
id: string,
shopId: string,
managerId?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/remove-manager/{id}',
            path: {
                'id': id,
                'shop_id': shopId,
            },
            query: {
                'manager_id': managerId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiManager({
id,
shopId,
}: {
id: string,
shopId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/manager/{id}',
            path: {
                'id': id,
                'shop_id': shopId,
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
requestBody?: Customer,
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
    public static getApi({
shopId,
page = 1,
limit = 250,
ids,
managerIds,
keyword,
sortBy,
fields,
haveManagers,
}: {
shopId: string,
page?: number,
limit?: number,
ids?: string,
managerIds?: string,
keyword?: string,
sortBy?: string,
fields?: string,
haveManagers?: boolean,
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
                'ids': ids,
                'manager_ids': managerIds,
                'keyword': keyword,
                'sort_by': sortBy,
                'fields': fields,
                'have_managers': haveManagers,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApi({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Array<Customer>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
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
    public static putApiCustomFields({
shopId,
id,
requestBody,
}: {
shopId: string,
id: string,
requestBody?: CustomField,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/{id}/custom_fields',
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
    public static putApi1({
shopId,
email,
requestBody,
}: {
shopId: string,
email: string,
requestBody?: Customer,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/{email}',
            path: {
                'shop_id': shopId,
                'email': email,
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
sortBy = 'id_desc',
fields,
requestBody,
}: {
shopId: string,
page?: number,
limit?: number,
sortBy?: string,
fields?: string,
requestBody?: CustomerFilter,
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
                'sort_by': sortBy,
                'fields': fields,
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
shopId,
idOrEmail,
}: {
shopId: string,
idOrEmail: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/{IdOrEmail}',
            path: {
                'shop_id': shopId,
                'IdOrEmail': idOrEmail,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiGoogleSheet({
sheetId,
sheetName,
requestBody,
}: {
sheetId?: string,
sheetName?: string,
requestBody?: GoogleSheetItem,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/google_sheet',
            query: {
                'sheet_id': sheetId,
                'sheet_name': sheetName,
            },
            body: requestBody,
            mediaType: 'application/json-patch+json',
        });
    }

}
