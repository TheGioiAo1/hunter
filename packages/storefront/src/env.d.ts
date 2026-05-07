/// <reference path="../.astro/types.d.ts" />

import type { Shop } from './engine/api-client.js';

declare namespace App {
  interface Locals {
    shop: Shop;
    shopId: string;
  }
}
