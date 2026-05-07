/**
 * Seed an admin user + a single shop into MongoDB.
 *
 * Usage (on Machine 2 — apps-secrets exports MONGO_USERS / MONGO_SHOPS env):
 *   ADMIN_EMAIL=admin@huntershop.us \
 *   ADMIN_PASSWORD='YourStrongPass!' \
 *   ADMIN_NAME='Hunter Admin' \
 *   SHOP_NAME='Hunter Shop' \
 *   SHOP_SLUG='hunter' \
 *   SHOP_DOMAIN='huntershop.us' \
 *   node --import tsx scripts/seed-admin-mongo.ts
 *
 * Idempotent: re-running with the same email updates the password hash
 * + role + status; same shop slug updates the shop record. Membership is
 * upserted to (admin, shop, role=owner).
 */
import "dotenv/config";
import bcrypt from "bcrypt";
import { nanoid } from "nanoid";
import { connectMongo, getMongoDb, closeMongo } from "../packages/core/src/modules/db/mongo.js";
import type { ShopDoc, UserDoc, UserShopDoc } from "../packages/core/src/modules/db/types.js";

const SALT_ROUNDS = 12;

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

async function seed(): Promise<void> {
  const email = required("ADMIN_EMAIL").toLowerCase().trim();
  const password = required("ADMIN_PASSWORD");
  const adminName = process.env.ADMIN_NAME ?? "Platform Admin";
  const shopName = process.env.SHOP_NAME ?? "Hunter Shop";
  const shopSlug = process.env.SHOP_SLUG ?? "hunter";
  const shopDomain = process.env.SHOP_DOMAIN ?? "huntershop.us";
  const currency = process.env.SHOP_CURRENCY ?? "USD";
  const timezone = process.env.SHOP_TIMEZONE ?? "UTC";

  console.log("[seed] Connecting to Mongo...");
  await connectMongo(["USERS", "SHOPS"]);

  const usersDb = await getMongoDb("USERS");
  const shopsDb = await getMongoDb("SHOPS");

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const now = new Date().toISOString();

  // 1. Upsert user
  const existing = await usersDb.collection<UserDoc>("users").findOne({ email });
  let userId: string;
  if (existing) {
    userId = existing._id;
    await usersDb.collection<UserDoc>("users").updateOne(
      { _id: userId },
      {
        $set: {
          name: adminName,
          password_hash: passwordHash,
          role: "owner",
          status: "active",
          is_default_admin: true,
          updated_at: now,
        },
      },
    );
    console.log(`[seed] Updated existing user: ${email} (id=${userId})`);
  } else {
    userId = nanoid();
    const userDoc: UserDoc = {
      _id: userId,
      email,
      name: adminName,
      password_hash: passwordHash,
      role: "owner",
      status: "active",
      is_default_admin: true,
      avatar_url: null,
      created_at: now,
      updated_at: now,
    };
    await usersDb.collection<UserDoc>("users").insertOne(userDoc);
    console.log(`[seed] Created user: ${email} (id=${userId})`);
  }

  // 2. Upsert shop (Mongo ObjectId-style 24-hex string preferred for store-admin
  //    URL pattern admin.huntershop.us/admin/store/<24-hex>; nanoid is fine too)
  const existingShop = await shopsDb.collection<ShopDoc>("shops").findOne({ slug: shopSlug });
  let shopId: string;
  if (existingShop) {
    shopId = existingShop._id;
    await shopsDb.collection<ShopDoc>("shops").updateOne(
      { _id: shopId },
      {
        $set: {
          name: shopName,
          domain: shopDomain,
          currency,
          timezone,
          status: "active",
        },
      },
    );
    console.log(`[seed] Updated existing shop: ${shopSlug} (id=${shopId})`);
  } else {
    shopId = nanoid();
    const shopDoc: ShopDoc = {
      _id: shopId,
      name: shopName,
      slug: shopSlug,
      domain: shopDomain,
      email: email,
      currency,
      timezone,
      plan: "professional",
      status: "active",
      created_at: now,
    };
    await shopsDb.collection<ShopDoc>("shops").insertOne(shopDoc);
    console.log(`[seed] Created shop: ${shopSlug} (id=${shopId}) domain=${shopDomain}`);
  }

  // 3. Upsert membership (user → shop, role=owner)
  await usersDb.collection<UserShopDoc>("user_shops").updateOne(
    { user_id: userId, shop_id: shopId },
    {
      $set: { role: "owner" },
      $setOnInsert: {
        _id: nanoid(),
        user_id: userId,
        shop_id: shopId,
        created_at: now,
      },
    },
    { upsert: true },
  );
  console.log(`[seed] Membership: user=${userId} shop=${shopId} role=owner`);

  console.log("\n[seed] DONE — credentials:");
  console.log(`  email:    ${email}`);
  console.log(`  password: <hidden>`);
  console.log(`  shop:     ${shopName} (${shopDomain})`);
  console.log(`  login:    https://accounts.${shopDomain}/accounts/login`);
}

seed()
  .catch((err) => {
    console.error("[seed] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMongo();
  });
