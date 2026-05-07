/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Product } from '../models/Product';
import type { ProductBulkUpdates } from '../models/ProductBulkUpdates';
import type { ProductFilter } from '../models/ProductFilter';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class ProductService {

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiTest({
shopId,
categoryId,
productId,
}: {
shopId: string,
categoryId?: string,
productId?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/test',
            path: {
                'shop_id': shopId,
            },
            query: {
                'categoryId': categoryId,
                'productId': productId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static putApiBulkUpdateInventory({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Record<string, number>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/bulk-update-inventory',
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
    public static postApiSmart({
shopId,
limit = 10,
fields,
requestBody,
}: {
shopId: string,
limit?: number,
fields?: string,
requestBody?: Array<Product>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/smart',
            path: {
                'shop_id': shopId,
            },
            query: {
                'limit': limit,
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
    public static postApiSkuNotExists({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Array<string>,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/sku-not-exists',
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
fields,
page = 1,
sortBy,
limit = 250,
isExport = false,
exportFields,
isCache = true,
isGenerateVariantSkuAuto = false,
requestBody,
}: {
shopId: string,
fields?: string,
page?: number,
sortBy?: string,
limit?: number,
isExport?: boolean,
exportFields?: string,
isCache?: boolean,
isGenerateVariantSkuAuto?: boolean,
requestBody?: ProductFilter,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/list',
            path: {
                'shop_id': shopId,
            },
            query: {
                'fields': fields,
                'page': page,
                'sort_by': sortBy,
                'limit': limit,
                'isExport': isExport,
                'exportFields': exportFields,
                'is_cache': isCache,
                'isGenerateVariantSkuAuto': isGenerateVariantSkuAuto,
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
published,
categorySlug,
tags,
fields,
sortBy,
minPrice,
maxPrice,
keyword,
keywords,
categoryIds,
productSku,
filter,
productIds,
isExport = false,
excludeCategoryIds,
exportFields,
isCache = true,
isGenerateVariantSkuAuto = false,
}: {
shopId: string,
page?: number,
limit?: number,
published?: boolean,
categorySlug?: string,
tags?: string,
fields?: string,
sortBy?: string,
minPrice?: number,
maxPrice?: number,
keyword?: string,
keywords?: string,
categoryIds?: string,
productSku?: string,
filter?: string,
productIds?: string,
isExport?: boolean,
excludeCategoryIds?: string,
exportFields?: string,
isCache?: boolean,
isGenerateVariantSkuAuto?: boolean,
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
                'published': published,
                'category_slug': categorySlug,
                'tags': tags,
                'fields': fields,
                'sort_by': sortBy,
                'min_price': minPrice,
                'max_price': maxPrice,
                'keyword': keyword,
                'keywords': keywords,
                'category_ids': categoryIds,
                'product_sku': productSku,
                'filter': filter,
                'product_ids': productIds,
                'isExport': isExport,
                'exclude_category_ids': excludeCategoryIds,
                'exportFields': exportFields,
                'is_cache': isCache,
                'isGenerateVariantSkuAuto': isGenerateVariantSkuAuto,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApi({
shopId,
checkExists = false,
clone = false,
requestBody,
}: {
shopId: string,
checkExists?: boolean,
clone?: boolean,
requestBody?: Product,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}',
            path: {
                'shop_id': shopId,
            },
            query: {
                'check_exists': checkExists,
                'clone': clone,
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
requestBody?: Array<Product>,
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
    public static getApiRand({
shopId,
keyword,
limit = 250,
category,
}: {
shopId: string,
keyword?: string,
limit?: number,
category?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/rand',
            path: {
                'shop_id': shopId,
            },
            query: {
                'keyword': keyword,
                'limit': limit,
                'category': category,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApi1({
shopId,
idOrSlug,
}: {
shopId: string,
idOrSlug: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/{IdOrSlug}',
            path: {
                'shop_id': shopId,
                'IdOrSlug': idOrSlug,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiOptions({
shopId,
categorySlug,
}: {
shopId: string,
categorySlug?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/options',
            path: {
                'shop_id': shopId,
            },
            query: {
                'category_slug': categorySlug,
            },
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
    public static putApi({
shopId,
productId,
checkExists = false,
clone = false,
requestBody,
}: {
shopId: string,
productId: string,
checkExists?: boolean,
clone?: boolean,
requestBody?: Product,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/{product_id}',
            path: {
                'shop_id': shopId,
                'product_id': productId,
            },
            query: {
                'check_exists': checkExists,
                'clone': clone,
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
productId,
}: {
shopId: string,
productId: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/{product_id}',
            path: {
                'shop_id': shopId,
                'product_id': productId,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static deleteApiBykeyword({
shopId,
keyword,
}: {
shopId: string,
keyword: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/{shop_id}/bykeyword/{keyword}',
            path: {
                'shop_id': shopId,
                'keyword': keyword,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiImages({
shopId,
page = 1,
limit = 50,
}: {
shopId: string,
page?: number,
limit?: number,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/{shop_id}/images',
            path: {
                'shop_id': shopId,
            },
            query: {
                'page': page,
                'limit': limit,
            },
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiVariants({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: Product,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/variants',
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
    public static putApiBulkUpdate({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: ProductBulkUpdates,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/{shop_id}/bulk-update',
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
    public static postApiBulkUpdate({
shopId,
requestBody,
}: {
shopId: string,
requestBody?: ProductBulkUpdates,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/bulk-update',
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
    public static postApiImport({
shopId,
emailDynamic,
formData,
}: {
shopId: string,
emailDynamic?: string,
formData?: {
file?: Blob;
},
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/import',
            path: {
                'shop_id': shopId,
            },
            query: {
                'emailDynamic': emailDynamic,
            },
            formData: formData,
            mediaType: 'multipart/form-data',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static postApiImportBaseCost({
shopId,
preview = true,
formData,
}: {
shopId: string,
preview?: boolean,
formData?: {
file?: Blob;
},
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/{shop_id}/import_base-cost',
            path: {
                'shop_id': shopId,
            },
            query: {
                'preview': preview,
            },
            formData: formData,
            mediaType: 'multipart/form-data',
        });
    }

    /**
     * @returns any Success
     * @throws ApiError
     */
    public static getApiExportTest({
categoryId,
productId,
}: {
categoryId?: string,
productId?: string,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/export-test',
            query: {
                'category_id': categoryId,
                'product_id': productId,
            },
        });
    }

}
