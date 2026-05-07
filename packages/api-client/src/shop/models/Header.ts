/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { Actions } from './Actions';
import type { AnnouncementBar } from './AnnouncementBar';
import type { Icons } from './Icons';
import type { Items } from './Items';
import type { Logo } from './Logo';

export type Header = {
    id?: string | null;
    name?: string | null;
    sys_name?: string | null;
    shop_id?: string | null;
    announcement_bar?: AnnouncementBar;
    logo?: Logo;
    items?: Items;
    icons?: Icons;
    actions?: Actions;
};
