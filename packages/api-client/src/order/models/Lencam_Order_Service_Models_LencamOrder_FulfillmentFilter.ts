/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type Lencam_Order_Service_Models_LencamOrder_FulfillmentFilter = {
    shop_id?: string | null;
    manager_id?: string | null;
    manager_ids?: Array<string> | null;
    id?: string | null;
    shortid?: string | null;
    ids?: Array<string> | null;
    shortids?: Array<string> | null;
    store_id?: string | null;
    store_ids?: Array<string> | null;
    inventory_ids?: Array<string> | null;
    exported?: boolean | null;
    order_id?: string | null;
    order_shortid?: string | null;
    order_shortids?: Array<string> | null;
    product_id?: string | null;
    product_ids?: Array<string> | null;
    variant_slug?: string | null;
    line_item_id?: string | null;
    line_item_ids?: Array<string> | null;
    line_item_shortid?: string | null;
    line_item_shortids?: Array<string> | null;
    line_item_status?: Array<string> | null;
    keyword?: string | null;
    keywordType?: string | null;
    from_date?: string | null;
    to_date?: string | null;
    from_export_date?: string | null;
    to_export_date?: string | null;
    tracking_from_date?: string | null;
    tracking_to_date?: string | null;
    tracking_update_from_date?: string | null;
    tracking_update_to_date?: string | null;
    customer_id?: string | null;
    customer_ids?: Array<string> | null;
    have_tracking?: boolean | null;
    tracking_status?: Array<string> | null;
    tracking_number?: string | null;
    tracking_numbers?: Array<string> | null;
    is_excel_file?: boolean | null;
    tracking_not_working?: boolean | null;
    tracking_not_working_day?: number | null;
    tracking_leadtime?: number | null;
    shipping_method?: string | null;
    shipping_methods?: Array<string> | null;
    custom_fields?: Record<string, string> | null;
    custom_field_values?: Record<string, Array<string>> | null;
    buy_label_status?: boolean | null;
};
