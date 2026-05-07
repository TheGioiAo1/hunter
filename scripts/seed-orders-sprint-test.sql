-- =========================================================================
-- SEED TEST DATA FOR ORDERS DASHBOARD (Sprints 1–6)
-- =========================================================================
-- Target store: diepanhtest (Biblio Bloom, id 8baf2545-d37c-4d57-a6f7-601e0b234b6a)
--
-- Every seeded row carries the 'seed-sprint-test' tag (orders) or a
-- deterministic email pattern (customers) so you can scrub them later with:
--   DELETE FROM orders WHERE 'seed-sprint-test' = ANY(tags);
--   DELETE FROM customers WHERE email LIKE '%@seed-sprint.test';
--
-- This script is idempotent — re-running deletes the previous seed first.
-- =========================================================================

BEGIN;

\set shop_id '''8baf2545-d37c-4d57-a6f7-601e0b234b6a'''

-- ---------- idempotency: wipe previous seed ----------
DELETE FROM pod_files WHERE order_id IN (
  SELECT id FROM orders WHERE shop_id = :shop_id::uuid AND 'seed-sprint-test' = ANY(tags)
);
DELETE FROM fulfillments WHERE order_id IN (
  SELECT id FROM orders WHERE shop_id = :shop_id::uuid AND 'seed-sprint-test' = ANY(tags)
);
DELETE FROM order_line_items WHERE order_id IN (
  SELECT id FROM orders WHERE shop_id = :shop_id::uuid AND 'seed-sprint-test' = ANY(tags)
);
DELETE FROM orders WHERE shop_id = :shop_id::uuid AND 'seed-sprint-test' = ANY(tags);
DELETE FROM customers WHERE shop_id = :shop_id::uuid AND email LIKE '%@seed-sprint.test';

-- ---------- customers ----------
INSERT INTO customers (id, shop_id, email, first_name, last_name, phone, verified_email, created_at)
VALUES
  ('11111111-1111-1111-1111-111111111101', :shop_id::uuid, 'alice@seed-sprint.test', 'Alice', 'Nguyen', '+14155550101', true, now() - interval '30 days'),
  ('11111111-1111-1111-1111-111111111102', :shop_id::uuid, 'bob@seed-sprint.test',   'Bob',   'Tran',   '+14155550102', true, now() - interval '28 days'),
  ('11111111-1111-1111-1111-111111111103', :shop_id::uuid, 'chi@seed-sprint.test',   'Chi',   'Le',     '+84901234567', true, now() - interval '25 days'),
  ('11111111-1111-1111-1111-111111111104', :shop_id::uuid, 'dan@seed-sprint.test',   'Dan',   'Smith',  '+442071234567', true, now() - interval '22 days');

-- ---------- orders ----------
-- Column order matches insert below for clarity.
-- Mix covers: tabs (open/on_hold/closed/cancelled/archived), payment statuses,
-- fulfillment statuses, channels (online_store/etsy/ebay/tiktok/amazon/shopify),
-- risk levels, UTM attribution, countries (US/VN/GB/AU/DE/FR), tags, dates.

INSERT INTO orders (
  id, shop_id, customer_id, email, phone,
  financial_status, fulfillment_status, currency,
  subtotal_price, total_discounts, total_shipping, total_tax, total_price,
  note, tags, closed_at, cancelled_at, cancel_reason,
  billing_address, shipping_address,
  source_channel, risk_level, risk_flags,
  utm_source, utm_medium, utm_campaign,
  created_at, updated_at
) VALUES
  -- 01: Open + paid + fulfilled + FB/CPC/summer — US
  ('22222222-2222-2222-2222-222222222201', :shop_id::uuid, '11111111-1111-1111-1111-111111111101', 'alice@seed-sprint.test', '+14155550101',
   'paid', 'fulfilled', 'USD', 45.00, 0, 5.00, 0, 50.00,
   'Gift wrap requested', ARRAY['seed-sprint-test','vip'], NULL, NULL, NULL,
   '{"name":"Alice Nguyen","address1":"123 Mission St","city":"San Francisco","province":"CA","country":"United States","country_code":"US","zip":"94105"}'::jsonb,
   '{"name":"Alice Nguyen","address1":"123 Mission St","city":"San Francisco","province":"CA","country":"United States","country_code":"US","zip":"94105"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, 'facebook', 'cpc', 'summer-2026',
   now() - interval '1 day', now() - interval '1 day'),

  -- 02: Open + paid + unfulfilled — needs picking
  ('22222222-2222-2222-2222-222222222202', :shop_id::uuid, '11111111-1111-1111-1111-111111111102', 'bob@seed-sprint.test', '+14155550102',
   'paid', 'unfulfilled', 'USD', 80.00, 0, 8.00, 0, 88.00,
   NULL, ARRAY['seed-sprint-test'], NULL, NULL, NULL,
   '{"name":"Bob Tran","address1":"55 Market St","city":"San Francisco","province":"CA","country":"United States","country_code":"US","zip":"94103"}'::jsonb,
   '{"name":"Bob Tran","address1":"55 Market St","city":"San Francisco","province":"CA","country":"United States","country_code":"US","zip":"94103"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, 'google', 'cpc', 'brand-2026',
   now() - interval '2 days', now() - interval '2 days'),

  -- 03: Pending payment — unpaid tab / pending filter
  ('22222222-2222-2222-2222-222222222203', :shop_id::uuid, '11111111-1111-1111-1111-111111111103', 'chi@seed-sprint.test', '+84901234567',
   'pending', 'unfulfilled', 'USD', 35.00, 0, 3.00, 0, 38.00,
   'Awaiting bank transfer', ARRAY['seed-sprint-test'], NULL, NULL, NULL,
   '{"name":"Chi Le","address1":"12 Nguyen Hue","city":"Ho Chi Minh","country":"Vietnam","country_code":"VN"}'::jsonb,
   '{"name":"Chi Le","address1":"12 Nguyen Hue","city":"Ho Chi Minh","country":"Vietnam","country_code":"VN"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, NULL, NULL, NULL,
   now() - interval '3 days', now() - interval '3 days'),

  -- 04: On hold — on_hold tab
  ('22222222-2222-2222-2222-222222222204', :shop_id::uuid, '11111111-1111-1111-1111-111111111101', 'alice@seed-sprint.test', '+14155550101',
   'paid', 'unfulfilled', 'USD', 120.00, 10.00, 5.00, 0, 115.00,
   'Customer asked to pause', ARRAY['seed-sprint-test','on_hold'], NULL, NULL, NULL,
   '{"name":"Alice Nguyen","address1":"123 Mission St","city":"San Francisco","province":"CA","country":"United States","country_code":"US"}'::jsonb,
   '{"name":"Alice Nguyen","address1":"123 Mission St","city":"San Francisco","province":"CA","country":"United States","country_code":"US"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, NULL, NULL, NULL,
   now() - interval '4 days', now() - interval '4 days'),

  -- 05: Closed (already delivered & closed)
  ('22222222-2222-2222-2222-222222222205', :shop_id::uuid, '11111111-1111-1111-1111-111111111104', 'dan@seed-sprint.test', '+442071234567',
   'paid', 'fulfilled', 'GBP', 62.00, 0, 8.00, 0, 70.00,
   NULL, ARRAY['seed-sprint-test'], now() - interval '5 days', NULL, NULL,
   '{"name":"Dan Smith","address1":"22 Baker Street","city":"London","country":"United Kingdom","country_code":"GB"}'::jsonb,
   '{"name":"Dan Smith","address1":"22 Baker Street","city":"London","country":"United Kingdom","country_code":"GB"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, 'google', 'organic', NULL,
   now() - interval '15 days', now() - interval '5 days'),

  -- 06: Cancelled
  ('22222222-2222-2222-2222-222222222206', :shop_id::uuid, '11111111-1111-1111-1111-111111111102', 'bob@seed-sprint.test', '+14155550102',
   'voided', 'unfulfilled', 'USD', 40.00, 0, 0, 0, 40.00,
   NULL, ARRAY['seed-sprint-test'], NULL, now() - interval '6 days', 'customer',
   '{"name":"Bob Tran","address1":"55 Market St","city":"San Francisco","province":"CA","country":"United States","country_code":"US"}'::jsonb,
   '{"name":"Bob Tran","address1":"55 Market St","city":"San Francisco","province":"CA","country":"United States","country_code":"US"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, NULL, NULL, NULL,
   now() - interval '7 days', now() - interval '6 days'),

  -- 07: HIGH risk order — risk filter
  ('22222222-2222-2222-2222-222222222207', :shop_id::uuid, '11111111-1111-1111-1111-111111111103', 'chi@seed-sprint.test', '+84901234567',
   'paid', 'unfulfilled', 'USD', 450.00, 0, 15.00, 0, 465.00,
   'High order value — flagged by risk engine', ARRAY['seed-sprint-test','fraud-review'], NULL, NULL, NULL,
   '{"name":"Chi Le","address1":"12 Nguyen Hue","city":"Ho Chi Minh","country":"Vietnam","country_code":"VN"}'::jsonb,
   '{"name":"Chi Le","address1":"45 Different Street","city":"Hanoi","country":"Vietnam","country_code":"VN"}'::jsonb,
   'online_store', 'high', '["billing_shipping_mismatch","high_value","new_customer"]'::jsonb, 'facebook', 'cpc', 'retargeting',
   now() - interval '2 hours', now() - interval '2 hours'),

  -- 08: Archived (archived tag) — open tab should exclude
  ('22222222-2222-2222-2222-222222222208', :shop_id::uuid, '11111111-1111-1111-1111-111111111101', 'alice@seed-sprint.test', '+14155550101',
   'paid', 'fulfilled', 'USD', 28.00, 0, 4.00, 0, 32.00,
   NULL, ARRAY['seed-sprint-test','archived'], NULL, NULL, NULL,
   '{"name":"Alice Nguyen","address1":"123 Mission St","city":"San Francisco","province":"CA","country":"United States","country_code":"US"}'::jsonb,
   '{"name":"Alice Nguyen","address1":"123 Mission St","city":"San Francisco","province":"CA","country":"United States","country_code":"US"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, NULL, NULL, NULL,
   now() - interval '45 days', now() - interval '40 days'),

  -- 09: Refunded (financial_status=refunded)
  ('22222222-2222-2222-2222-222222222209', :shop_id::uuid, '11111111-1111-1111-1111-111111111104', 'dan@seed-sprint.test', '+442071234567',
   'refunded', 'fulfilled', 'GBP', 22.00, 0, 3.00, 0, 25.00,
   'Refunded — customer changed mind', ARRAY['seed-sprint-test'], NULL, NULL, NULL,
   '{"name":"Dan Smith","address1":"22 Baker Street","city":"London","country":"United Kingdom","country_code":"GB"}'::jsonb,
   '{"name":"Dan Smith","address1":"22 Baker Street","city":"London","country":"United Kingdom","country_code":"GB"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, NULL, NULL, NULL,
   now() - interval '20 days', now() - interval '10 days'),

  -- 10: Partially refunded
  ('22222222-2222-2222-2222-222222222210', :shop_id::uuid, '11111111-1111-1111-1111-111111111102', 'bob@seed-sprint.test', '+14155550102',
   'partially_refunded', 'fulfilled', 'USD', 90.00, 0, 7.00, 0, 97.00,
   NULL, ARRAY['seed-sprint-test'], NULL, NULL, NULL,
   '{"name":"Bob Tran","address1":"55 Market St","city":"San Francisco","province":"CA","country":"United States","country_code":"US"}'::jsonb,
   '{"name":"Bob Tran","address1":"55 Market St","city":"San Francisco","province":"CA","country":"United States","country_code":"US"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, NULL, NULL, NULL,
   now() - interval '12 days', now() - interval '8 days'),

  -- 11: Etsy source — channel filter
  ('22222222-2222-2222-2222-222222222211', :shop_id::uuid, '11111111-1111-1111-1111-111111111101', 'alice@seed-sprint.test', '+14155550101',
   'paid', 'fulfilled', 'USD', 34.00, 0, 4.50, 0, 38.50,
   'Imported from Etsy', ARRAY['seed-sprint-test'], NULL, NULL, NULL,
   '{"name":"Alice Nguyen","address1":"123 Mission St","city":"San Francisco","country":"United States","country_code":"US"}'::jsonb,
   '{"name":"Alice Nguyen","address1":"123 Mission St","city":"San Francisco","country":"United States","country_code":"US"}'::jsonb,
   'etsy', 'low', '[]'::jsonb, NULL, NULL, NULL,
   now() - interval '5 days', now() - interval '5 days'),

  -- 12: eBay source
  ('22222222-2222-2222-2222-222222222212', :shop_id::uuid, '11111111-1111-1111-1111-111111111102', 'bob@seed-sprint.test', '+14155550102',
   'paid', 'fulfilled', 'USD', 27.00, 0, 3.50, 0, 30.50,
   NULL, ARRAY['seed-sprint-test'], NULL, NULL, NULL,
   '{"name":"Bob Tran","address1":"55 Market St","city":"San Francisco","country":"United States","country_code":"US"}'::jsonb,
   '{"name":"Bob Tran","address1":"55 Market St","city":"San Francisco","country":"United States","country_code":"US"}'::jsonb,
   'ebay', 'low', '[]'::jsonb, NULL, NULL, NULL,
   now() - interval '6 days', now() - interval '6 days'),

  -- 13: TikTok shop source
  ('22222222-2222-2222-2222-222222222213', :shop_id::uuid, '11111111-1111-1111-1111-111111111103', 'chi@seed-sprint.test', '+84901234567',
   'paid', 'partial', 'USD', 75.00, 5.00, 6.00, 0, 76.00,
   NULL, ARRAY['seed-sprint-test'], NULL, NULL, NULL,
   '{"name":"Chi Le","address1":"12 Nguyen Hue","city":"Ho Chi Minh","country":"Vietnam","country_code":"VN"}'::jsonb,
   '{"name":"Chi Le","address1":"12 Nguyen Hue","city":"Ho Chi Minh","country":"Vietnam","country_code":"VN"}'::jsonb,
   'tiktok', 'medium', '[]'::jsonb, 'tiktok', 'social', 'tt-live-apr',
   now() - interval '8 days', now() - interval '8 days'),

  -- 14: Amazon source
  ('22222222-2222-2222-2222-222222222214', :shop_id::uuid, '11111111-1111-1111-1111-111111111104', 'dan@seed-sprint.test', '+442071234567',
   'paid', 'fulfilled', 'GBP', 45.00, 0, 6.00, 0, 51.00,
   NULL, ARRAY['seed-sprint-test'], NULL, NULL, NULL,
   '{"name":"Dan Smith","address1":"22 Baker Street","city":"London","country":"United Kingdom","country_code":"GB"}'::jsonb,
   '{"name":"Dan Smith","address1":"22 Baker Street","city":"London","country":"United Kingdom","country_code":"GB"}'::jsonb,
   'amazon', 'low', '[]'::jsonb, NULL, NULL, NULL,
   now() - interval '10 days', now() - interval '10 days'),

  -- 15: Shopify import
  ('22222222-2222-2222-2222-222222222215', :shop_id::uuid, '11111111-1111-1111-1111-111111111101', 'alice@seed-sprint.test', '+14155550101',
   'paid', 'fulfilled', 'USD', 58.00, 0, 7.00, 0, 65.00,
   'Imported from Shopify CSV', ARRAY['seed-sprint-test'], NULL, NULL, NULL,
   '{"name":"Alice Nguyen","address1":"123 Mission St","city":"San Francisco","country":"United States","country_code":"US"}'::jsonb,
   '{"name":"Alice Nguyen","address1":"123 Mission St","city":"San Francisco","country":"United States","country_code":"US"}'::jsonb,
   'shopify', 'low', '[]'::jsonb, NULL, NULL, NULL,
   now() - interval '14 days', now() - interval '14 days'),

  -- 16: Pending (another unpaid from Instagram campaign)
  ('22222222-2222-2222-2222-222222222216', :shop_id::uuid, '11111111-1111-1111-1111-111111111102', 'bob@seed-sprint.test', '+14155550102',
   'pending', 'unfulfilled', 'USD', 112.00, 0, 9.00, 0, 121.00,
   NULL, ARRAY['seed-sprint-test'], NULL, NULL, NULL,
   '{"name":"Bob Tran","address1":"55 Market St","city":"San Francisco","country":"United States","country_code":"US"}'::jsonb,
   '{"name":"Bob Tran","address1":"55 Market St","city":"San Francisco","country":"United States","country_code":"US"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, 'instagram', 'cpc', 'reel-launch',
   now() - interval '1 day', now() - interval '1 day'),

  -- 17: Pending + old (falls in 30d-old range)
  ('22222222-2222-2222-2222-222222222217', :shop_id::uuid, '11111111-1111-1111-1111-111111111104', 'dan@seed-sprint.test', '+442071234567',
   'pending', 'unfulfilled', 'GBP', 25.00, 0, 4.00, 0, 29.00,
   'Old pending — maybe stuck', ARRAY['seed-sprint-test'], NULL, NULL, NULL,
   '{"name":"Dan Smith","address1":"22 Baker Street","city":"London","country":"United Kingdom","country_code":"GB"}'::jsonb,
   '{"name":"Dan Smith","address1":"22 Baker Street","city":"London","country":"United Kingdom","country_code":"GB"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, NULL, NULL, NULL,
   now() - interval '28 days', now() - interval '28 days'),

  -- 18: Germany — country filter
  ('22222222-2222-2222-2222-222222222218', :shop_id::uuid, NULL, 'greta.mueller@seed-sprint.test', NULL,
   'paid', 'fulfilled', 'EUR', 42.00, 0, 5.00, 0, 47.00,
   NULL, ARRAY['seed-sprint-test'], NULL, NULL, NULL,
   '{"name":"Greta Mueller","address1":"Alexanderplatz 1","city":"Berlin","country":"Germany","country_code":"DE"}'::jsonb,
   '{"name":"Greta Mueller","address1":"Alexanderplatz 1","city":"Berlin","country":"Germany","country_code":"DE"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, 'google', 'cpc', 'eu-launch',
   now() - interval '6 days', now() - interval '6 days'),

  -- 19: France — country filter
  ('22222222-2222-2222-2222-222222222219', :shop_id::uuid, NULL, 'pierre.dubois@seed-sprint.test', NULL,
   'paid', 'fulfilled', 'EUR', 38.00, 0, 5.00, 0, 43.00,
   NULL, ARRAY['seed-sprint-test'], NULL, NULL, NULL,
   '{"name":"Pierre Dubois","address1":"10 Rue de Rivoli","city":"Paris","country":"France","country_code":"FR"}'::jsonb,
   '{"name":"Pierre Dubois","address1":"10 Rue de Rivoli","city":"Paris","country":"France","country_code":"FR"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, 'google', 'cpc', 'eu-launch',
   now() - interval '4 days', now() - interval '4 days'),

  -- 20: Australia — country filter
  ('22222222-2222-2222-2222-222222222220', :shop_id::uuid, NULL, 'mia.taylor@seed-sprint.test', NULL,
   'paid', 'unfulfilled', 'AUD', 68.00, 0, 12.00, 0, 80.00,
   NULL, ARRAY['seed-sprint-test','priority'], NULL, NULL, NULL,
   '{"name":"Mia Taylor","address1":"200 George St","city":"Sydney","province":"NSW","country":"Australia","country_code":"AU"}'::jsonb,
   '{"name":"Mia Taylor","address1":"200 George St","city":"Sydney","province":"NSW","country":"Australia","country_code":"AU"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, 'facebook', 'cpc', 'au-launch',
   now() - interval '2 days', now() - interval '2 days'),

  -- 21: Open, has tracking number — tracking filter
  ('22222222-2222-2222-2222-222222222221', :shop_id::uuid, '11111111-1111-1111-1111-111111111101', 'alice@seed-sprint.test', '+14155550101',
   'paid', 'fulfilled', 'USD', 52.00, 0, 6.00, 0, 58.00,
   NULL, ARRAY['seed-sprint-test'], NULL, NULL, NULL,
   '{"name":"Alice Nguyen","address1":"123 Mission St","city":"San Francisco","country":"United States","country_code":"US"}'::jsonb,
   '{"name":"Alice Nguyen","address1":"123 Mission St","city":"San Francisco","country":"United States","country_code":"US"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, NULL, NULL, NULL,
   now() - interval '9 days', now() - interval '9 days'),

  -- 22: Yesterday — fresh
  ('22222222-2222-2222-2222-222222222222', :shop_id::uuid, '11111111-1111-1111-1111-111111111103', 'chi@seed-sprint.test', '+84901234567',
   'paid', 'fulfilled', 'USD', 30.00, 0, 3.00, 0, 33.00,
   NULL, ARRAY['seed-sprint-test'], NULL, NULL, NULL,
   '{"name":"Chi Le","address1":"12 Nguyen Hue","city":"Ho Chi Minh","country":"Vietnam","country_code":"VN"}'::jsonb,
   '{"name":"Chi Le","address1":"12 Nguyen Hue","city":"Ho Chi Minh","country":"Vietnam","country_code":"VN"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, 'tiktok', 'social', 'tt-live-apr',
   now() - interval '12 hours', now() - interval '12 hours'),

  -- 23: Today — freshest
  ('22222222-2222-2222-2222-222222222223', :shop_id::uuid, '11111111-1111-1111-1111-111111111102', 'bob@seed-sprint.test', '+14155550102',
   'paid', 'unfulfilled', 'USD', 140.00, 0, 10.00, 0, 150.00,
   'Bulk order', ARRAY['seed-sprint-test','wholesale'], NULL, NULL, NULL,
   '{"name":"Bob Tran","address1":"55 Market St","city":"San Francisco","country":"United States","country_code":"US"}'::jsonb,
   '{"name":"Bob Tran","address1":"55 Market St","city":"San Francisco","country":"United States","country_code":"US"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, 'facebook', 'cpc', 'summer-2026',
   now() - interval '2 hours', now() - interval '2 hours'),

  -- 24: Another high-risk (total two high risk orders)
  ('22222222-2222-2222-2222-222222222224', :shop_id::uuid, NULL, 'fraud.test@seed-sprint.test', NULL,
   'paid', 'unfulfilled', 'USD', 380.00, 0, 20.00, 0, 400.00,
   'Multiple failed cards before success', ARRAY['seed-sprint-test','fraud-review'], NULL, NULL, NULL,
   '{"name":"Jon Doe","address1":"1 Test Lane","city":"New York","province":"NY","country":"United States","country_code":"US"}'::jsonb,
   '{"name":"Jon Doe","address1":"1 Test Lane","city":"New York","province":"NY","country":"United States","country_code":"US"}'::jsonb,
   'online_store', 'high', '["card_velocity","ip_mismatch"]'::jsonb, NULL, NULL, NULL,
   now() - interval '6 hours', now() - interval '6 hours'),

  -- 25: Long-tail UTM campaign — utm_term search
  ('22222222-2222-2222-2222-222222222225', :shop_id::uuid, '11111111-1111-1111-1111-111111111104', 'dan@seed-sprint.test', '+442071234567',
   'paid', 'fulfilled', 'GBP', 19.00, 0, 3.00, 0, 22.00,
   NULL, ARRAY['seed-sprint-test'], NULL, NULL, NULL,
   '{"name":"Dan Smith","address1":"22 Baker Street","city":"London","country":"United Kingdom","country_code":"GB"}'::jsonb,
   '{"name":"Dan Smith","address1":"22 Baker Street","city":"London","country":"United Kingdom","country_code":"GB"}'::jsonb,
   'online_store', 'low', '[]'::jsonb, 'google', 'cpc', 'brand-search',
   now() - interval '16 days', now() - interval '16 days');

-- Set utm_term / utm_content separately (avoid blowing up the value list)
UPDATE orders SET utm_term = 'acrylic+vase', utm_content = 'ad-variant-a'
  WHERE id = '22222222-2222-2222-2222-222222222201';
UPDATE orders SET utm_term = 'bookmark+gift', utm_content = 'carousel-b'
  WHERE id = '22222222-2222-2222-2222-222222222207';
UPDATE orders SET utm_term = 'biblio+bloom+vase', utm_content = 'brand-ad-c'
  WHERE id = '22222222-2222-2222-2222-222222222225';

-- ---------- line items ----------
-- Every order gets 1–2 line items with hand-crafted titles/skus so search works
INSERT INTO order_line_items (order_id, title, variant_title, sku, quantity, price, properties)
VALUES
  ('22222222-2222-2222-2222-222222222201', 'Acrylic Book Vase — Rose Gold', 'Large / Rose Gold', 'BV-LG-ROSE', 1, 45.00, '[{"name":"Engraving","value":"Alice"}]'::jsonb),
  ('22222222-2222-2222-2222-222222222202', 'Dragon Acrylic Bookmark',        'Standard',          'BM-DRG-01',  2, 18.00, NULL),
  ('22222222-2222-2222-2222-222222222202', 'Cat Acrylic Bookmark',           'Standard',          'BM-CAT-01',  2, 22.00, NULL),
  ('22222222-2222-2222-2222-222222222203', 'Acrylic Vase Duo',                NULL,               'AV-DUO',     1, 35.00, NULL),
  ('22222222-2222-2222-2222-222222222204', 'Custom Engraved Vase',           'Large / Clear',     'BV-LG-CUST', 2, 60.00, '[{"name":"Engraving","value":"Happy Birthday"}]'::jsonb),
  ('22222222-2222-2222-2222-222222222205', 'Phantom of the Opera Bookmark',   NULL,               'BM-PHN-01',  1, 22.00, NULL),
  ('22222222-2222-2222-2222-222222222205', 'Gift Wrap',                       NULL,               'GFT-WRAP',   1, 40.00, NULL),
  ('22222222-2222-2222-2222-222222222206', 'A Christmas Carol Bookmark',      NULL,               'BM-CHR-01',  2, 20.00, NULL),
  ('22222222-2222-2222-2222-222222222207', 'Premium Custom Vase — Bulk',      'XL / Clear',        'BV-XL-CUST', 6, 75.00, '[{"name":"Engraving","value":"Corporate Gifts"}]'::jsonb),
  ('22222222-2222-2222-2222-222222222208', 'Les Miserables Bookmark',         NULL,               'BM-LSM-01',  1, 28.00, NULL),
  ('22222222-2222-2222-2222-222222222209', 'Dragon Acrylic Bookmark',         NULL,               'BM-DRG-01',  1, 22.00, NULL),
  ('22222222-2222-2222-2222-222222222210', 'Acrylic Book Vase — Blue',       'Medium / Blue',     'BV-MD-BLUE', 2, 45.00, NULL),
  ('22222222-2222-2222-2222-222222222211', 'Etsy Exclusive Bookmark',         NULL,               'ETS-BM-01',  1, 34.00, NULL),
  ('22222222-2222-2222-2222-222222222212', 'eBay Listing Bookmark',           NULL,               'EBA-BM-01',  1, 27.00, NULL),
  ('22222222-2222-2222-2222-222222222213', 'TikTok Live Special Vase',       'Medium',            'TT-BV-01',   1, 75.00, NULL),
  ('22222222-2222-2222-2222-222222222214', 'Amazon Prime Vase',               NULL,               'AMZ-BV-01',  1, 45.00, NULL),
  ('22222222-2222-2222-2222-222222222215', 'Shopify Imported Bookmark',       NULL,               'SHP-BM-01',  2, 29.00, NULL),
  ('22222222-2222-2222-2222-222222222216', 'Acrylic Book Vase — Clear',      'XL',                'BV-XL-CLR',  2, 56.00, NULL),
  ('22222222-2222-2222-2222-222222222217', 'Cat Acrylic Bookmark',            NULL,               'BM-CAT-01',  1, 25.00, NULL),
  ('22222222-2222-2222-2222-222222222218', 'Berlin Special Vase',             NULL,               'BV-BER-01',  1, 42.00, NULL),
  ('22222222-2222-2222-2222-222222222219', 'Paris Limited Bookmark',          NULL,               'BM-PAR-01',  1, 38.00, NULL),
  ('22222222-2222-2222-2222-222222222220', 'Sydney Opera Bookmark',           NULL,               'BM-SYD-01',  2, 34.00, '[{"name":"Gift note","value":"Happy Mother''s Day"}]'::jsonb),
  ('22222222-2222-2222-2222-222222222221', 'Acrylic Vase — Tracked',         NULL,               'BV-TRK-01',  1, 52.00, NULL),
  ('22222222-2222-2222-2222-222222222222', 'Fresh Daily Bookmark',            NULL,               'BM-DLY-01',  1, 30.00, NULL),
  ('22222222-2222-2222-2222-222222222223', 'Wholesale Bookmark Bundle',       '50-pack',           'WHS-BM-50', 1, 140.00, NULL),
  ('22222222-2222-2222-2222-222222222224', 'Expensive Vase — Flagged',       'XL / Platinum',     'BV-XL-PLAT', 4, 95.00, NULL),
  ('22222222-2222-2222-2222-222222222225', 'Classic Literature Bookmark',     NULL,               'BM-CLS-01',  1, 19.00, NULL);

-- ---------- fulfillments (with / without tracking) ----------
-- Some fulfilled orders get tracking numbers, some don't.
INSERT INTO fulfillments (order_id, status, tracking_company, tracking_number, tracking_url, shipped_at, created_at)
VALUES
  ('22222222-2222-2222-2222-222222222201', 'success', 'USPS',    '9400111899223334445501', 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223334445501', now() - interval '12 hours', now() - interval '18 hours'),
  ('22222222-2222-2222-2222-222222222205', 'success', 'Royal Mail','RM123456789GB',         'https://www.royalmail.com/track-your-item#/tracking-results/RM123456789GB',  now() - interval '6 days',  now() - interval '7 days'),
  ('22222222-2222-2222-2222-222222222208', 'success', 'USPS',    NULL, NULL, now() - interval '44 days', now() - interval '44 days'),
  ('22222222-2222-2222-2222-222222222209', 'success', 'Royal Mail',NULL, NULL, now() - interval '15 days', now() - interval '15 days'),
  ('22222222-2222-2222-2222-222222222210', 'success', 'USPS',    '9400111899223334445510', NULL, now() - interval '11 days', now() - interval '11 days'),
  ('22222222-2222-2222-2222-222222222211', 'success', 'USPS',    NULL, NULL, now() - interval '4 days',  now() - interval '4 days'),
  ('22222222-2222-2222-2222-222222222212', 'success', 'UPS',     '1Z999AA10123456784',     'https://www.ups.com/track?tracknum=1Z999AA10123456784', now() - interval '5 days', now() - interval '5 days'),
  ('22222222-2222-2222-2222-222222222213', 'success', 'J&T',     'JT123456789VN',          NULL, now() - interval '6 days', now() - interval '7 days'),
  ('22222222-2222-2222-2222-222222222214', 'success', 'Royal Mail','RM987654321GB',         NULL, now() - interval '9 days', now() - interval '9 days'),
  ('22222222-2222-2222-2222-222222222215', 'success', 'USPS',    '9400111899223334445515', NULL, now() - interval '13 days', now() - interval '13 days'),
  ('22222222-2222-2222-2222-222222222218', 'success', 'DHL',     'DHL1234567890DE',        'https://www.dhl.com/track/DHL1234567890DE', now() - interval '5 days', now() - interval '5 days'),
  ('22222222-2222-2222-2222-222222222219', 'success', 'La Poste','LP1234567FR',            NULL, now() - interval '3 days', now() - interval '3 days'),
  ('22222222-2222-2222-2222-222222222221', 'success', 'USPS',    '9400111899223334445521', 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223334445521', now() - interval '8 days', now() - interval '8 days'),
  ('22222222-2222-2222-2222-222222222222', 'success', 'VNPost',  'VN1234567VN',            NULL, now() - interval '6 hours', now() - interval '10 hours'),
  ('22222222-2222-2222-2222-222222222225', 'success', 'Royal Mail','RM555555555GB',         NULL, now() - interval '14 days', now() - interval '14 days');

-- ---------- pod_files (print file status filter) ----------
-- Orders 04 & 07 have print files "pending" (any_generating filter should match)
-- Order 01 has a print file already "generated" (all_generated filter should match)
-- line_item_id is required → pick the first line item for the order via subquery.
INSERT INTO pod_files (shop_id, order_id, line_item_id, file_key, file_url, filename, mime_type, size, status)
SELECT :shop_id::uuid, oli.order_id, oli.id,
       'pod/' || substr(oli.order_id::text,1,8) || '/design.png',
       'https://example.test/pod/' || substr(oli.order_id::text,1,8) || '/design.png',
       'design-' || substr(oli.order_id::text,1,8) || '.png',
       'image/png', 524288, s.status
FROM (VALUES
  ('22222222-2222-2222-2222-222222222201'::uuid, 'generated'),
  ('22222222-2222-2222-2222-222222222204'::uuid, 'pending'),
  ('22222222-2222-2222-2222-222222222207'::uuid, 'pending'),
  ('22222222-2222-2222-2222-222222222220'::uuid, 'generated')
) AS s(order_id, status)
JOIN LATERAL (
  SELECT id, order_id FROM order_line_items
  WHERE order_line_items.order_id = s.order_id
  ORDER BY created_at ASC LIMIT 1
) AS oli ON true;

-- ---------- summary ----------
SELECT
  COUNT(*) AS seeded_orders,
  COUNT(*) FILTER (WHERE closed_at IS NULL AND cancelled_at IS NULL
                     AND NOT (COALESCE(tags,ARRAY[]::text[]) @> ARRAY['on_hold']::text[])
                     AND NOT (COALESCE(tags,ARRAY[]::text[]) @> ARRAY['archived']::text[])) AS open_tab,
  COUNT(*) FILTER (WHERE COALESCE(tags,ARRAY[]::text[]) @> ARRAY['on_hold']::text[]) AS on_hold_tab,
  COUNT(*) FILTER (WHERE closed_at IS NOT NULL) AS closed_tab,
  COUNT(*) FILTER (WHERE cancelled_at IS NOT NULL) AS cancelled,
  COUNT(*) FILTER (WHERE financial_status='pending') AS pending_pay,
  COUNT(*) FILTER (WHERE financial_status='voided') AS voided,
  COUNT(*) FILTER (WHERE financial_status='refunded') AS refunded,
  COUNT(*) FILTER (WHERE financial_status='partially_refunded') AS partial_refund,
  COUNT(*) FILTER (WHERE fulfillment_status='fulfilled') AS fulfilled,
  COUNT(*) FILTER (WHERE fulfillment_status='partial') AS partial_fulfill,
  COUNT(*) FILTER (WHERE risk_level='high') AS high_risk,
  COUNT(*) FILTER (WHERE utm_source IS NOT NULL) AS with_utm,
  COUNT(DISTINCT source_channel) AS distinct_channels
FROM orders
WHERE shop_id = :shop_id::uuid AND 'seed-sprint-test' = ANY(tags);

COMMIT;
