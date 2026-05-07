/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Lencam_Order_Service_Models_LencamOrder_Leadtime } from './Lencam_Order_Service_Models_LencamOrder_Leadtime';
import type { Lencam_Order_Service_Models_LencamOrder_TrackingEvent } from './Lencam_Order_Service_Models_LencamOrder_TrackingEvent';
import type { Lencam_Order_Service_Models_LencamOrder_Translation } from './Lencam_Order_Service_Models_LencamOrder_Translation';

export type Lencam_Order_Service_Models_LencamOrder_Tracking = {
    id?: string | null;
    short_id?: string | null;
    company?: string | null;
    translation?: Lencam_Order_Service_Models_LencamOrder_Translation;
    number?: string | null;
    url?: string | null;
    status?: string | null;
    subscribed_to_17track?: boolean | null;
    last_crawled_at?: string | null;
    created_at?: string | null;
    isHidden?: boolean | null;
    crawl_log?: Array<any> | null;
    events?: Array<Lencam_Order_Service_Models_LencamOrder_TrackingEvent> | null;
    item_short_id?: string | null;
    time_metrics?: Lencam_Order_Service_Models_LencamOrder_Leadtime;
};
