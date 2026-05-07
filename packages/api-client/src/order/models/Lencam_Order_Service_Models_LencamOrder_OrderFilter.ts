/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type Lencam_Order_Service_Models_LencamOrder_OrderFilter = {
    shop_id?: string | null;
    id?: string | null;
    ids?: Array<string> | null;
    short_id?: string | null;
    short_ids?: Array<string> | null;
    order_numbers?: Array<string> | null;
    status?: Array<string> | null;
    keyword?: string | null;
    keywordType?: string | null;
    tags?: Array<string> | null;
    manager_ids?: Array<string> | null;
    line_item_variant_option_values?: string | null;
    custom_fields?: Record<string, string> | null;
    custom_field_values?: Record<string, Array<string>> | null;
    custom_field_name?: string | null;
    inventory_ids?: Array<string> | null;
    billing_id?: string | null;
    billing_ids?: Array<string> | null;
    billing_email?: string | null;
    from_date?: string | null;
    to_date?: string | null;
    from_set_supdate?: string | null;
    to_set_supdate?: string | null;
    from_export_fulfill?: string | null;
    to_export_fulfill?: string | null;
    tracking_number?: string | null;
    tracking_list?: Array<string> | null;
    tracking_status?: Array<string> | null;
    from_tracking?: string | null;
    to_tracking?: string | null;
    customer_id?: string | null;
    customer_email?: string | null;
    country_code?: string | null;
    lst_country_codes?: Array<string> | null;
    shipping_method?: string | null;
    shipping_methods?: Array<string> | null;
    product_ids?: Array<string> | null;
    line_item_status?: Array<string> | null;
    line_item_short_ids?: Array<string> | null;
    line_item_ids?: Array<string> | null;
    line_item_cf?: Record<string, string> | null;
    line_item_cf_values?: Record<string, Array<string>> | null;
    have_items?: boolean | null;
    line_item_exists?: Record<string, boolean> | null;
    line_item_cf_exists?: Record<string, string> | null;
    variant_slug?: string | null;
    product_id?: string | null;
    payment_status?: boolean | null;
    price_compare_base_cost?: string | null;
    price_compare_transaction?: string | null;
    have_fulfillments?: boolean | null;
    have_discount?: boolean | null;
    from_pay_date?: string | null;
    to_pay_date?: string | null;
    from_picked_date?: string | null;
    to_picked_date?: string | null;
    fulfillment_id?: string | null;
    category_ids?: Array<string> | null;
    is_address_valid?: boolean | null;
    exclude_billing_emails?: Array<string> | null;
};
