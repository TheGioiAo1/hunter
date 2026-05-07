import "dotenv/config";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";

const db = new Kysely<any>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }),
  }),
});

async function seed() {
  console.log("Seeding Gbox Platform...\n");

  // USERS
  const [admin] = await db.insertInto("users").values([
    { email: "admin@gbox.co", name: "Platform Admin", role: "owner", status: "active" },
    { email: "merchant@gbox.co", name: "Store Owner", role: "admin", status: "active" },
  ]).returning(["id", "email"]).execute();
  console.log("  Users: 2 created");

  // SHOPS
  const shops = await db.insertInto("shops").values([
    { name: "Gbox Demo Store", slug: "gbox-demo", domain: "demo.gbox.co", email: "demo@gbox.co", phone: "+1-555-0100", address: "123 Commerce St", city: "San Francisco", province: "CA", country: "US", zip: "94102", currency: "USD", timezone: "America/Los_Angeles", plan: "professional", status: "active" },
    { name: "Fashion Hub", slug: "fashion-hub", domain: "fashion.gbox.co", email: "hello@fashionhub.com", currency: "USD", timezone: "America/New_York", plan: "basic", status: "active" },
    { name: "Tech Gadgets", slug: "tech-gadgets", domain: "tech.gbox.co", email: "info@techgadgets.com", currency: "USD", timezone: "America/Chicago", plan: "professional", status: "active" },
  ]).returning(["id", "name"]).execute();
  console.log("  Shops: 3 created");

  await db.insertInto("user_shops").values([
    { user_id: admin.id, shop_id: shops[0].id, role: "owner" },
    { user_id: admin.id, shop_id: shops[1].id, role: "owner" },
    { user_id: admin.id, shop_id: shops[2].id, role: "owner" },
  ]).execute();

  // LOCATIONS
  const locations = await db.insertInto("locations").values([
    { shop_id: shops[0].id, name: "Main Warehouse", address: "100 Warehouse Rd", city: "San Francisco", country: "US", zip: "94103", is_primary: true, active: true },
  ]).returning(["id"]).execute();

  // PRODUCTS (Shop 1)
  const s1 = shops[0].id;
  const products = await db.insertInto("products").values([
    { shop_id: s1, title: "Classic White T-Shirt", slug: "classic-white-tshirt", body_html: "<p>Premium cotton t-shirt.</p>", vendor: "Gbox Basics", product_type: "T-Shirts", status: "active", tags: ["clothing","basics"], published_at: sql`now()` },
    { shop_id: s1, title: "Slim Fit Jeans", slug: "slim-fit-jeans", body_html: "<p>Modern slim fit jeans.</p>", vendor: "Gbox Denim", product_type: "Jeans", status: "active", tags: ["clothing","denim"], published_at: sql`now()` },
    { shop_id: s1, title: "Running Sneakers Pro", slug: "running-sneakers-pro", body_html: "<p>Lightweight running shoes.</p>", vendor: "Gbox Sports", product_type: "Shoes", status: "active", tags: ["shoes","sports"], published_at: sql`now()` },
    { shop_id: s1, title: "Leather Backpack", slug: "leather-backpack", body_html: "<p>Genuine leather backpack.</p>", vendor: "Gbox Accessories", product_type: "Bags", status: "active", tags: ["bags","leather"], published_at: sql`now()` },
    { shop_id: s1, title: "Wireless Earbuds", slug: "wireless-earbuds", body_html: "<p>True wireless earbuds with ANC.</p>", vendor: "Gbox Audio", product_type: "Electronics", status: "active", tags: ["electronics","audio"], published_at: sql`now()` },
    { shop_id: s1, title: "Organic Coffee Beans", slug: "organic-coffee-beans", body_html: "<p>Single origin, medium roast.</p>", vendor: "Gbox Coffee", product_type: "Food", status: "active", tags: ["food","coffee"], published_at: sql`now()` },
  ]).returning(["id","title"]).execute();

  await db.insertInto("product_variants").values([
    { product_id: products[0].id, title: "Small", price: 29.99, compare_at_price: 39.99, sku: "WT-S", inventory_quantity: 150, option1: "Small", position: 1, requires_shipping: true, taxable: true },
    { product_id: products[0].id, title: "Medium", price: 29.99, compare_at_price: 39.99, sku: "WT-M", inventory_quantity: 200, option1: "Medium", position: 2, requires_shipping: true, taxable: true },
    { product_id: products[0].id, title: "Large", price: 29.99, compare_at_price: 39.99, sku: "WT-L", inventory_quantity: 100, option1: "Large", position: 3, requires_shipping: true, taxable: true },
    { product_id: products[1].id, title: "32x32", price: 79.99, sku: "SFJ-32", inventory_quantity: 120, option1: "32x32", position: 1, requires_shipping: true, taxable: true },
    { product_id: products[2].id, title: "US 10", price: 129.99, compare_at_price: 159.99, sku: "RSP-10", inventory_quantity: 65, option1: "US 10", position: 1, requires_shipping: true, taxable: true },
    { product_id: products[3].id, title: "Default", price: 189.99, sku: "LB-01", inventory_quantity: 30, position: 1, requires_shipping: true, taxable: true },
    { product_id: products[4].id, title: "Default", price: 99.99, compare_at_price: 149.99, sku: "WE-01", inventory_quantity: 200, position: 1, requires_shipping: true, taxable: true },
    { product_id: products[5].id, title: "250g", price: 18.99, sku: "OCB-250", inventory_quantity: 500, option1: "250g", position: 1, requires_shipping: true, taxable: true },
    { product_id: products[5].id, title: "1kg", price: 59.99, sku: "OCB-1K", inventory_quantity: 200, option1: "1kg", position: 2, requires_shipping: true, taxable: true },
  ]).execute();
  console.log("  Products: 6 + 9 variants");

  // CUSTOMERS
  const customers = await db.insertInto("customers").values([
    { shop_id: s1, email: "john@example.com", first_name: "John", last_name: "Smith", phone: "+1-555-1001", orders_count: 3, total_spent: 259.97, status: "active", verified_email: true },
    { shop_id: s1, email: "jane@example.com", first_name: "Jane", last_name: "Doe", phone: "+1-555-1002", orders_count: 5, total_spent: 489.95, status: "active", verified_email: true },
    { shop_id: s1, email: "bob@example.com", first_name: "Bob", last_name: "Wilson", orders_count: 1, total_spent: 129.99, status: "active", verified_email: true },
  ]).returning(["id"]).execute();
  console.log("  Customers: 3 created");

  // ORDERS
  const orders = await db.insertInto("orders").values([
    { shop_id: s1, order_number: 1001, customer_id: customers[0].id, email: "john@example.com", financial_status: "paid", fulfillment_status: "fulfilled", currency: "USD", subtotal_price: 59.98, total_tax: 5.40, total_shipping: 5.99, total_price: 71.37, total_discounts: 0, note: "VIP customer" },
    { shop_id: s1, order_number: 1002, customer_id: customers[1].id, email: "jane@example.com", financial_status: "paid", fulfillment_status: "unfulfilled", currency: "USD", subtotal_price: 129.99, total_tax: 11.70, total_shipping: 0, total_price: 141.69, total_discounts: 0 },
    { shop_id: s1, order_number: 1003, customer_id: customers[2].id, email: "bob@example.com", financial_status: "pending", fulfillment_status: "unfulfilled", currency: "USD", subtotal_price: 189.99, total_tax: 17.10, total_shipping: 9.99, total_price: 217.08, total_discounts: 0 },
  ]).returning(["id"]).execute();

  await db.insertInto("order_line_items").values([
    { order_id: orders[0].id, product_id: products[0].id, title: "Classic White T-Shirt", variant_title: "Medium", sku: "WT-M", quantity: 2, price: 29.99, fulfillment_status: "fulfilled", requires_shipping: true, taxable: true },
    { order_id: orders[1].id, product_id: products[2].id, title: "Running Sneakers Pro", variant_title: "US 10", sku: "RSP-10", quantity: 1, price: 129.99, fulfillment_status: "unfulfilled", requires_shipping: true, taxable: true },
    { order_id: orders[2].id, product_id: products[3].id, title: "Leather Backpack", sku: "LB-01", quantity: 1, price: 189.99, fulfillment_status: "unfulfilled", requires_shipping: true, taxable: true },
  ]).execute();

  await db.insertInto("transactions").values([
    { order_id: orders[0].id, kind: "sale", gateway: "stripe", amount: 71.37, currency: "USD", status: "success", gateway_transaction_id: "ch_demo_001" },
    { order_id: orders[1].id, kind: "sale", gateway: "paypal", amount: 141.69, currency: "USD", status: "success", gateway_transaction_id: "PAY_demo_002" },
  ]).execute();
  console.log("  Orders: 3 + 3 items + 2 transactions");

  // SHIPPING
  const [zone] = await db.insertInto("shipping_zones").values([
    { shop_id: s1, name: "Domestic US", countries: JSON.stringify(["US"]) },
  ]).returning(["id"]).execute();
  await db.insertInto("shipping_rates").values([
    { zone_id: zone.id, name: "Standard", price: 5.99, type: "flat" },
    { zone_id: zone.id, name: "Free (over $100)", price: 0, type: "price_based", min_value: 100 },
  ]).execute();
  console.log("  Shipping: 1 zone + 2 rates");

  // PAGES
  await db.insertInto("pages").values([
    { shop_id: s1, title: "About Us", slug: "about-us", body_html: "<h2>Our Story</h2><p>Gbox Demo Store was founded with a mission to provide quality products.</p>", published: true },
    { shop_id: s1, title: "Contact", slug: "contact-us", body_html: "<h2>Contact</h2><p>Email: demo@gbox.co | Phone: +1-555-0100</p>", published: true },
  ]).execute();
  console.log("  Pages: 2 created");

  // DISCOUNTS
  await db.insertInto("discounts").values([
    { shop_id: s1, title: "Welcome 10% Off", code: "WELCOME10", type: "percentage", value: 10, value_type: "percentage", applies_to: "all", minimum_requirement_type: "none", once_per_customer: true, starts_at: sql`now()`, status: "active" },
  ]).execute();
  console.log("  Discounts: 1 (WELCOME10)");

  console.log("\n  SEED COMPLETE!");
  console.log("  Test: http://192.168.1.13/api/2026-04/stats.json");
  await db.destroy();
}
seed().catch(console.error);
