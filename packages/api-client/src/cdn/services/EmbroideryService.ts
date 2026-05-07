/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class EmbroideryService {

    /**
     * @returns any OK
     * @throws ApiError
     */
    public static postApiEmbStitches({
formData,
}: {
formData?: {
file?: Blob;
},
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/emb/stitches',
            formData: formData,
            mediaType: 'multipart/form-data',
        });
    }

    /**
     * @returns any OK
     * @throws ApiError
     */
    public static getApiEmbGenV2({
imageUrl,
width = 200,
removeBackground = true,
}: {
imageUrl?: string,
width?: number,
removeBackground?: boolean,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/emb/gen-v2',
            query: {
                'imageUrl': imageUrl,
                'width': width,
                'removeBackground': removeBackground,
            },
        });
    }

    /**
     * @returns any OK
     * @throws ApiError
     */
    public static getApiEmbGen({
path,
width = 200,
removeBackground = true,
}: {
path?: string,
width?: number,
removeBackground?: boolean,
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/emb/gen',
            query: {
                'path': path,
                'width': width,
                'removeBackground': removeBackground,
            },
        });
    }

    /**
     * @returns any OK
     * @throws ApiError
     */
    public static postApiEmbGen({
width = 200,
removeBackground = true,
formData,
}: {
width?: number,
removeBackground?: boolean,
formData?: {
file?: Blob;
},
}): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/emb/gen',
            query: {
                'width': width,
                'removeBackground': removeBackground,
            },
            formData: formData,
            mediaType: 'multipart/form-data',
        });
    }

}
