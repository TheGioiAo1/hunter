/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { JumpPayment } from './JumpPayment';
import type { MetaTag } from './MetaTag';
import type { NewsLetter } from './NewsLetter';
import type { PinterestAds } from './PinterestAds';
import type { Script } from './Script';
import type { Server } from './Server';
import type { ShopProtection } from './ShopProtection';
import type { SocialLink } from './SocialLink';
import type { Tip } from './Tip';
import type { TwitterTracking } from './TwitterTracking';
import type { Working } from './Working';

export type Shop = {
    id?: string | null;
    user_id?: string | null;
    favicon?: string | null;
    logo?: string | null;
    social_image?: string | null;
    public_domain?: string | null;
    private_domain?: string | null;
    title?: string | null;
    description?: string | null;
    name?: string | null;
    legal_name_of_business?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    apartment?: string | null;
    city?: string | null;
    province?: string | null;
    country_code?: string | null;
    zip_code?: string | null;
    work_time?: string | null;
    timezone?: string | null;
    prefix?: string | null;
    suffix?: string | null;
    currency?: string | null;
    expired_at?: string | null;
    active?: boolean | null;
    cloudflare_id?: string | null;
    pinterest_ids?: Array<string> | null;
    pinterest_ads?: PinterestAds;
    bing_ids?: Array<string> | null;
    titkok_ids?: Array<string> | null;
    twitter_ids?: Array<TwitterTracking> | null;
    google_analytics_ids?: Array<string> | null;
    google_ads_conversion?: Array<string> | null;
    facebook_pixel?: Array<string> | null;
    klaviyo_api_key?: string | null;
    meta_tags?: Array<MetaTag> | null;
    script?: Script;
    create_date?: string | null;
    locale_name?: string | null;
    tip?: Tip;
    socials_link?: Array<SocialLink> | null;
    server?: Server;
    language?: string | null;
    working?: Working;
    is_show_review?: boolean | null;
    news_letter?: NewsLetter;
    delete_at?: string | null;
    deleted?: boolean | null;
    enable_page?: boolean | null;
    jump_payment?: JumpPayment;
    enable_watermark?: boolean | null;
    protection?: ShopProtection;
};
