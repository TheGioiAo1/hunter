-- ============================================================
-- SEED TEST DATA for shop: diepanhtest (Biblio Bloom)
-- Shop ID: 8baf2545-d37c-4d57-a6f7-601e0b234b6a
-- User ID: acab45a6-cc7b-4219-95c3-d24690c90383
-- ============================================================

DO $$
DECLARE
  sid uuid := '8baf2545-d37c-4d57-a6f7-601e0b234b6a';
  uid uuid := 'acab45a6-cc7b-4219-95c3-d24690c90383';
  p1 uuid := 'e0976e9f-bc8a-4bee-8b5b-e393a7592958';
  p2 uuid := 'a00e89f8-f9c2-43f3-b500-19f9f2879d25';
  p3 uuid := '220751f8-9a76-474d-a6d2-7d63ba1feccc';
  p4 uuid := 'ca2668e3-8bc1-4ef3-a017-89621d035834';
  p5 uuid := 'aaf00b24-06d6-4dc2-85df-1d694413a018';
  p6 uuid := '90b5c1bb-d4fb-4bc4-824d-1daa161686bd';
BEGIN

-- ==============================
-- CUSTOMERS (15)
-- ==============================
INSERT INTO customers (id, shop_id, email, first_name, last_name, phone, accepts_marketing, orders_count, total_spent, tags, note, status, created_at, updated_at) VALUES
  ('c0000001-0000-0000-0000-000000000001', sid, 'nguyen.van.an@gmail.com', 'An', 'Nguyen Van', '+84912345001', true, 5, 2450000, ARRAY['vip','returning'], 'Khach hang VIP, mua sach thuong xuyen', 'active', NOW()-interval '90 days', NOW()-interval '2 days'),
  ('c0000001-0000-0000-0000-000000000002', sid, 'tran.thi.binh@gmail.com', 'Binh', 'Tran Thi', '+84912345002', true, 3, 890000, ARRAY['new'], 'Khach moi, thich sach tieng Anh', 'active', NOW()-interval '60 days', NOW()-interval '5 days'),
  ('c0000001-0000-0000-0000-000000000003', sid, 'le.minh.cuong@gmail.com', 'Cuong', 'Le Minh', '+84912345003', false, 1, 320000, ARRAY['wholesale'], 'Mua si cho cua hang sach', 'active', NOW()-interval '45 days', NOW()-interval '10 days'),
  ('c0000001-0000-0000-0000-000000000004', sid, 'pham.hong.dao@gmail.com', 'Dao', 'Pham Hong', '+84912345004', true, 8, 5200000, ARRAY['vip','returning','loyalty'], 'Top customer, da mua 8 don', 'active', NOW()-interval '120 days', NOW()-interval '1 day'),
  ('c0000001-0000-0000-0000-000000000005', sid, 'hoang.duc.em@gmail.com', 'Em', 'Hoang Duc', '+84912345005', false, 0, 0, ARRAY['abandoned'], 'Da tao tai khoan nhung chua mua', 'active', NOW()-interval '30 days', NOW()-interval '30 days'),
  ('c0000001-0000-0000-0000-000000000006', sid, 'vo.thi.phuong@gmail.com', 'Phuong', 'Vo Thi', '+84912345006', true, 2, 640000, ARRAY['returning'], '', 'active', NOW()-interval '75 days', NOW()-interval '8 days'),
  ('c0000001-0000-0000-0000-000000000007', sid, 'bui.quang.gia@gmail.com', 'Gia', 'Bui Quang', '+84912345007', true, 4, 1850000, ARRAY['vip'], 'Hay mua qua tang', 'active', NOW()-interval '100 days', NOW()-interval '3 days'),
  ('c0000001-0000-0000-0000-000000000008', sid, 'dang.thi.huong@gmail.com', 'Huong', 'Dang Thi', '+84912345008', false, 1, 250000, NULL, '', 'active', NOW()-interval '20 days', NOW()-interval '20 days'),
  ('c0000001-0000-0000-0000-000000000009', sid, 'ngo.van.inh@gmail.com', 'Inh', 'Ngo Van', '+84912345009', true, 0, 0, ARRAY['subscribed'], 'Dang ky nhan tin nhung chua mua', 'active', NOW()-interval '15 days', NOW()-interval '15 days'),
  ('c0000001-0000-0000-0000-000000000010', sid, 'ly.thi.kim@gmail.com', 'Kim', 'Ly Thi', '+84912345010', true, 6, 3100000, ARRAY['vip','returning'], 'Khach hang lau nam', 'active', NOW()-interval '180 days', NOW()-interval '4 days'),
  ('c0000001-0000-0000-0000-000000000011', sid, 'sarah.johnson@gmail.com', 'Sarah', 'Johnson', '+14155551234', true, 2, 780000, ARRAY['international'], 'US customer', 'active', NOW()-interval '50 days', NOW()-interval '12 days'),
  ('c0000001-0000-0000-0000-000000000012', sid, 'tanaka.yuki@gmail.com', 'Yuki', 'Tanaka', '+81901234567', false, 1, 450000, ARRAY['international'], 'Japan customer', 'active', NOW()-interval '35 days', NOW()-interval '35 days'),
  ('c0000001-0000-0000-0000-000000000013', sid, 'test.disabled@gmail.com', 'Disabled', 'Account', '+84912345013', false, 0, 0, NULL, 'Tai khoan bi khoa do spam', 'disabled', NOW()-interval '60 days', NOW()-interval '40 days'),
  ('c0000001-0000-0000-0000-000000000014', sid, 'mai.thu.loan@gmail.com', 'Loan', 'Mai Thu', '+84912345014', true, 3, 920000, ARRAY['returning'], 'Mua cho con', 'active', NOW()-interval '85 days', NOW()-interval '6 days'),
  ('c0000001-0000-0000-0000-000000000015', sid, 'do.thanh.minh@gmail.com', 'Minh', 'Do Thanh', '+84912345015', true, 7, 4300000, ARRAY['vip','loyalty'], 'Khach hang trung thanh', 'active', NOW()-interval '200 days', NOW()-interval '2 days')
ON CONFLICT (id) DO NOTHING;

-- ==============================
-- CUSTOMER ADDRESSES
-- ==============================
INSERT INTO customer_addresses (id, customer_id, first_name, last_name, company, address1, address2, city, province, province_code, country, country_code, zip, phone, is_default, created_at) VALUES
  ('a0000001-0000-0000-0000-000000000001', 'c0000001-0000-0000-0000-000000000001', 'An', 'Nguyen Van', NULL, '123 Nguyen Hue', 'Phuong Ben Nghe', 'Ho Chi Minh', 'HCM', 'HCM', 'Vietnam', 'VN', '70000', '+84912345001', true, NOW()-interval '90 days'),
  ('a0000001-0000-0000-0000-000000000002', 'c0000001-0000-0000-0000-000000000002', 'Binh', 'Tran Thi', NULL, '456 Tran Hung Dao', 'Quan 5', 'Ho Chi Minh', 'HCM', 'HCM', 'Vietnam', 'VN', '70000', '+84912345002', true, NOW()-interval '60 days'),
  ('a0000001-0000-0000-0000-000000000003', 'c0000001-0000-0000-0000-000000000004', 'Dao', 'Pham Hong', 'Pham Books Co.', '789 Le Loi', 'Tang 3', 'Ho Chi Minh', 'HCM', 'HCM', 'Vietnam', 'VN', '70000', '+84912345004', true, NOW()-interval '120 days'),
  ('a0000001-0000-0000-0000-000000000004', 'c0000001-0000-0000-0000-000000000004', 'Dao', 'Pham Hong', NULL, '12 Hoang Dieu', 'Quan 4', 'Ho Chi Minh', 'HCM', 'HCM', 'Vietnam', 'VN', '70000', '+84912345004', false, NOW()-interval '60 days'),
  ('a0000001-0000-0000-0000-000000000005', 'c0000001-0000-0000-0000-000000000011', 'Sarah', 'Johnson', NULL, '123 Main Street', 'Apt 4B', 'San Francisco', 'California', 'CA', 'United States', 'US', '94102', '+14155551234', true, NOW()-interval '50 days'),
  ('a0000001-0000-0000-0000-000000000006', 'c0000001-0000-0000-0000-000000000010', 'Kim', 'Ly Thi', NULL, '88 Ba Trieu', '', 'Ha Noi', 'HN', 'HN', 'Vietnam', 'VN', '10000', '+84912345010', true, NOW()-interval '180 days'),
  ('a0000001-0000-0000-0000-000000000007', 'c0000001-0000-0000-0000-000000000015', 'Minh', 'Do Thanh', 'Minh Books', '15 Nguyen Trai', 'Quan 1', 'Ho Chi Minh', 'HCM', 'HCM', 'Vietnam', 'VN', '70000', '+84912345015', true, NOW()-interval '200 days')
ON CONFLICT (id) DO NOTHING;

-- ==============================
-- ORDERS (12 orders, various statuses)
-- ==============================
INSERT INTO orders (id, shop_id, order_number, customer_id, email, phone, financial_status, fulfillment_status, currency, subtotal_price, total_discounts, total_shipping, total_tax, total_price, total_weight, note, tags, billing_address, shipping_address, created_at, updated_at) VALUES
  ('d0000001-0000-0000-0000-000000000001', sid, 1001, 'c0000001-0000-0000-0000-000000000001', 'nguyen.van.an@gmail.com', '+84912345001', 'paid', 'fulfilled', 'VND', 650000, 0, 30000, 0, 680000, 500, 'Giao truoc 5h chieu', ARRAY['completed'], '{"first_name":"An","last_name":"Nguyen","address1":"123 Nguyen Hue","city":"HCM","country":"Vietnam"}', '{"first_name":"An","last_name":"Nguyen","address1":"123 Nguyen Hue","city":"HCM","country":"Vietnam"}', NOW()-interval '80 days', NOW()-interval '78 days'),
  ('d0000001-0000-0000-0000-000000000002', sid, 1002, 'c0000001-0000-0000-0000-000000000001', 'nguyen.van.an@gmail.com', '+84912345001', 'paid', 'fulfilled', 'VND', 890000, 50000, 30000, 0, 870000, 800, NULL, ARRAY['completed'], '{"first_name":"An","last_name":"Nguyen","address1":"123 Nguyen Hue","city":"HCM","country":"Vietnam"}', '{"first_name":"An","last_name":"Nguyen","address1":"123 Nguyen Hue","city":"HCM","country":"Vietnam"}', NOW()-interval '60 days', NOW()-interval '57 days'),
  ('d0000001-0000-0000-0000-000000000003', sid, 1003, 'c0000001-0000-0000-0000-000000000004', 'pham.hong.dao@gmail.com', '+84912345004', 'paid', 'partial', 'VND', 1250000, 100000, 0, 0, 1150000, 1200, 'Giao 2 dot', ARRAY['partial'], '{"first_name":"Dao","last_name":"Pham","address1":"789 Le Loi","city":"HCM","country":"Vietnam"}', '{"first_name":"Dao","last_name":"Pham","address1":"789 Le Loi","city":"HCM","country":"Vietnam"}', NOW()-interval '45 days', NOW()-interval '40 days'),
  ('d0000001-0000-0000-0000-000000000004', sid, 1004, 'c0000001-0000-0000-0000-000000000002', 'tran.thi.binh@gmail.com', '+84912345002', 'paid', 'unfulfilled', 'VND', 320000, 0, 30000, 0, 350000, 400, NULL, ARRAY['pending-ship'], '{"first_name":"Binh","last_name":"Tran","address1":"456 Tran Hung Dao","city":"HCM","country":"Vietnam"}', '{"first_name":"Binh","last_name":"Tran","address1":"456 Tran Hung Dao","city":"HCM","country":"Vietnam"}', NOW()-interval '3 days', NOW()-interval '3 days'),
  ('d0000001-0000-0000-0000-000000000005', sid, 1005, 'c0000001-0000-0000-0000-000000000007', 'bui.quang.gia@gmail.com', '+84912345007', 'pending', 'unfulfilled', 'VND', 450000, 0, 50000, 0, 500000, 600, 'Doi xac nhan thanh toan', ARRAY['pending-payment'], '{"first_name":"Gia","last_name":"Bui","address1":"55 Pasteur","city":"HCM","country":"Vietnam"}', '{"first_name":"Gia","last_name":"Bui","address1":"55 Pasteur","city":"HCM","country":"Vietnam"}', NOW()-interval '1 day', NOW()-interval '1 day'),
  ('d0000001-0000-0000-0000-000000000006', sid, 1006, 'c0000001-0000-0000-0000-000000000010', 'ly.thi.kim@gmail.com', '+84912345010', 'paid', 'fulfilled', 'VND', 780000, 0, 0, 0, 780000, 900, NULL, ARRAY['completed','gift'], '{"first_name":"Kim","last_name":"Ly","address1":"88 Ba Trieu","city":"Ha Noi","country":"Vietnam"}', '{"first_name":"Kim","last_name":"Ly","address1":"88 Ba Trieu","city":"Ha Noi","country":"Vietnam"}', NOW()-interval '30 days', NOW()-interval '27 days'),
  ('d0000001-0000-0000-0000-000000000007', sid, 1007, 'c0000001-0000-0000-0000-000000000015', 'do.thanh.minh@gmail.com', '+84912345015', 'refunded', 'fulfilled', 'VND', 450000, 0, 30000, 0, 480000, 500, 'San pham bi loi, hoan tien', ARRAY['refunded'], '{"first_name":"Minh","last_name":"Do","address1":"15 Nguyen Trai","city":"HCM","country":"Vietnam"}', '{"first_name":"Minh","last_name":"Do","address1":"15 Nguyen Trai","city":"HCM","country":"Vietnam"}', NOW()-interval '25 days', NOW()-interval '20 days'),
  ('d0000001-0000-0000-0000-000000000008', sid, 1008, 'c0000001-0000-0000-0000-000000000011', 'sarah.johnson@gmail.com', '+14155551234', 'paid', 'unfulfilled', 'USD', 35.00, 0, 15.00, 0, 50.00, 600, 'Ship to US address', ARRAY['international'], '{"first_name":"Sarah","last_name":"Johnson","address1":"123 Main St","city":"San Francisco","country":"US"}', '{"first_name":"Sarah","last_name":"Johnson","address1":"123 Main St","city":"San Francisco","country":"US"}', NOW()-interval '10 days', NOW()-interval '10 days'),
  ('d0000001-0000-0000-0000-000000000009', sid, 1009, 'c0000001-0000-0000-0000-000000000004', 'pham.hong.dao@gmail.com', '+84912345004', 'paid', 'fulfilled', 'VND', 1850000, 200000, 0, 0, 1650000, 2000, 'Don lon, giao express', ARRAY['completed','express','vip'], '{"first_name":"Dao","last_name":"Pham","address1":"789 Le Loi","city":"HCM","country":"Vietnam"}', '{"first_name":"Dao","last_name":"Pham","address1":"789 Le Loi","city":"HCM","country":"Vietnam"}', NOW()-interval '15 days', NOW()-interval '12 days'),
  ('d0000001-0000-0000-0000-000000000010', sid, 1010, NULL, 'guest.buyer@gmail.com', '+84912345099', 'paid', 'unfulfilled', 'VND', 320000, 0, 30000, 0, 350000, 400, 'Guest checkout', ARRAY['guest'], '{"first_name":"Guest","last_name":"Buyer","address1":"99 Hai Ba Trung","city":"HCM","country":"Vietnam"}', '{"first_name":"Guest","last_name":"Buyer","address1":"99 Hai Ba Trung","city":"HCM","country":"Vietnam"}', NOW()-interval '2 days', NOW()-interval '2 days'),
  ('d0000001-0000-0000-0000-000000000011', sid, 1011, 'c0000001-0000-0000-0000-000000000014', 'mai.thu.loan@gmail.com', '+84912345014', 'voided', 'unfulfilled', 'VND', 520000, 0, 30000, 0, 550000, 500, NULL, ARRAY['cancelled'], '{"first_name":"Loan","last_name":"Mai","address1":"22 Ly Thuong Kiet","city":"HCM","country":"Vietnam"}', '{"first_name":"Loan","last_name":"Mai","address1":"22 Ly Thuong Kiet","city":"HCM","country":"Vietnam"}', NOW()-interval '18 days', NOW()-interval '17 days'),
  ('d0000001-0000-0000-0000-000000000012', sid, 1012, 'c0000001-0000-0000-0000-000000000015', 'do.thanh.minh@gmail.com', '+84912345015', 'paid', 'fulfilled', 'VND', 2100000, 150000, 0, 0, 1950000, 2500, 'Don hang moi nhat', ARRAY['completed','loyalty'], '{"first_name":"Minh","last_name":"Do","address1":"15 Nguyen Trai","city":"HCM","country":"Vietnam"}', '{"first_name":"Minh","last_name":"Do","address1":"15 Nguyen Trai","city":"HCM","country":"Vietnam"}', NOW()-interval '1 day', NOW()-interval '12 hours')
ON CONFLICT (id) DO NOTHING;

-- ==============================
-- ORDER LINE ITEMS
-- ==============================
INSERT INTO order_line_items (id, order_id, product_id, variant_id, title, variant_title, sku, quantity, price, total_discount, fulfillment_status, requires_shipping, taxable, gift_card, created_at) VALUES
  ('e1000001-0000-0000-0000-000000000001', 'd0000001-0000-0000-0000-000000000001', p1, NULL, 'The Great Gatsby Acrylic Book Vase - Colorful', 'Default', 'GBV-GG-CLR', 2, 325000, 0, 'fulfilled', true, true, false, NOW()-interval '80 days'),
  ('e1000001-0000-0000-0000-000000000002', 'd0000001-0000-0000-0000-000000000002', p2, NULL, 'The Great Gatsby Acrylic Book Vase - Black', 'Default', 'GBV-GG-BLK', 1, 325000, 0, 'fulfilled', true, true, false, NOW()-interval '60 days'),
  ('e1000001-0000-0000-0000-000000000003', 'd0000001-0000-0000-0000-000000000002', p3, NULL, 'Pride and Prejudice Acrylic Book Vase - II - Colorful', 'Default', 'GBV-PP-CLR', 2, 282500, 50000, 'fulfilled', true, true, false, NOW()-interval '60 days'),
  ('e1000001-0000-0000-0000-000000000004', 'd0000001-0000-0000-0000-000000000003', p4, NULL, 'Pride and Prejudice Acrylic Book Vase - II - Black', 'Default', 'GBV-PP-BLK', 3, 275000, 50000, 'fulfilled', true, true, false, NOW()-interval '45 days'),
  ('e1000001-0000-0000-0000-000000000005', 'd0000001-0000-0000-0000-000000000003', p5, NULL, 'Just One More Chapter Acrylic Book Vase - Colorful', 'Default', 'GBV-JM-CLR', 1, 425000, 50000, 'unfulfilled', true, true, false, NOW()-interval '45 days'),
  ('e1000001-0000-0000-0000-000000000006', 'd0000001-0000-0000-0000-000000000004', p6, NULL, 'Just One More Chapter Acrylic Book Vase - Black', 'Default', 'GBV-JM-BLK', 1, 320000, 0, 'unfulfilled', true, true, false, NOW()-interval '3 days'),
  ('e1000001-0000-0000-0000-000000000007', 'd0000001-0000-0000-0000-000000000005', p1, NULL, 'The Great Gatsby Acrylic Book Vase - Colorful', 'Default', 'GBV-GG-CLR', 1, 325000, 0, 'unfulfilled', true, true, false, NOW()-interval '1 day'),
  ('e1000001-0000-0000-0000-000000000008', 'd0000001-0000-0000-0000-000000000005', p3, NULL, 'Pride and Prejudice Acrylic Book Vase - II - Colorful', 'Default', 'GBV-PP-CLR', 1, 125000, 0, 'unfulfilled', true, true, false, NOW()-interval '1 day'),
  ('e1000001-0000-0000-0000-000000000009', 'd0000001-0000-0000-0000-000000000006', p2, NULL, 'The Great Gatsby Acrylic Book Vase - Black', 'Default', 'GBV-GG-BLK', 2, 325000, 0, 'fulfilled', true, true, false, NOW()-interval '30 days'),
  ('e1000001-0000-0000-0000-000000000010', 'd0000001-0000-0000-0000-000000000006', p5, NULL, 'Just One More Chapter Acrylic Book Vase - Colorful', 'Default', 'GBV-JM-CLR', 1, 130000, 0, 'fulfilled', true, true, false, NOW()-interval '30 days'),
  ('e1000001-0000-0000-0000-000000000011', 'd0000001-0000-0000-0000-000000000007', p4, NULL, 'Pride and Prejudice Acrylic Book Vase - II - Black', 'Default', 'GBV-PP-BLK', 1, 450000, 0, 'fulfilled', true, true, false, NOW()-interval '25 days'),
  ('e1000001-0000-0000-0000-000000000012', 'd0000001-0000-0000-0000-000000000008', p1, NULL, 'The Great Gatsby Acrylic Book Vase - Colorful', 'Default', 'GBV-GG-CLR', 1, 35.00, 0, 'unfulfilled', true, true, false, NOW()-interval '10 days'),
  ('e1000001-0000-0000-0000-000000000013', 'd0000001-0000-0000-0000-000000000009', p2, NULL, 'The Great Gatsby Acrylic Book Vase - Black', 'Default', 'GBV-GG-BLK', 3, 325000, 100000, 'fulfilled', true, true, false, NOW()-interval '15 days'),
  ('e1000001-0000-0000-0000-000000000014', 'd0000001-0000-0000-0000-000000000009', p6, NULL, 'Just One More Chapter Acrylic Book Vase - Black', 'Default', 'GBV-JM-BLK', 2, 425000, 100000, 'fulfilled', true, true, false, NOW()-interval '15 days'),
  ('e1000001-0000-0000-0000-000000000015', 'd0000001-0000-0000-0000-000000000010', p3, NULL, 'Pride and Prejudice Acrylic Book Vase - II - Colorful', 'Default', 'GBV-PP-CLR', 1, 320000, 0, 'unfulfilled', true, true, false, NOW()-interval '2 days'),
  ('e1000001-0000-0000-0000-000000000016', 'd0000001-0000-0000-0000-000000000012', p1, NULL, 'The Great Gatsby Acrylic Book Vase - Colorful', 'Default', 'GBV-GG-CLR', 4, 325000, 100000, 'fulfilled', true, true, false, NOW()-interval '1 day'),
  ('e1000001-0000-0000-0000-000000000017', 'd0000001-0000-0000-0000-000000000012', p5, NULL, 'Just One More Chapter Acrylic Book Vase - Colorful', 'Default', 'GBV-JM-CLR', 2, 425000, 50000, 'fulfilled', true, true, false, NOW()-interval '1 day')
ON CONFLICT (id) DO NOTHING;

-- ==============================
-- DISCOUNTS (6)
-- ==============================
INSERT INTO discounts (id, shop_id, title, code, type, value, value_type, applies_to, minimum_requirement_type, minimum_requirement_value, usage_limit, once_per_customer, usage_count, starts_at, ends_at, status, created_at, updated_at) VALUES
  ('dc000001-0000-0000-0000-000000000001', sid, 'Welcome 10%', 'WELCOME10', 'percentage', 10, 'percentage', 'all', 'none', 0, 100, true, 23, NOW()-interval '60 days', NOW()+interval '30 days', 'active', NOW()-interval '60 days', NOW()-interval '1 day'),
  ('dc000001-0000-0000-0000-000000000002', sid, 'Summer Sale 20%', 'SUMMER20', 'percentage', 20, 'percentage', 'all', 'purchase_amount', 500000, 50, false, 12, NOW()-interval '30 days', NOW()+interval '60 days', 'active', NOW()-interval '30 days', NOW()-interval '3 days'),
  ('dc000001-0000-0000-0000-000000000003', sid, 'Free Shipping', 'FREESHIP', 'free_shipping', 100, 'percentage', 'all', 'purchase_amount', 300000, NULL, false, 45, NOW()-interval '90 days', NULL, 'active', NOW()-interval '90 days', NOW()-interval '2 days'),
  ('dc000001-0000-0000-0000-000000000004', sid, 'VIP 50k Off', 'VIP50K', 'fixed_amount', 50000, 'fixed', 'all', 'purchase_amount', 200000, NULL, false, 8, NOW()-interval '45 days', NOW()+interval '90 days', 'active', NOW()-interval '45 days', NOW()-interval '5 days'),
  ('dc000001-0000-0000-0000-000000000005', sid, 'Flash Sale 30%', 'FLASH30', 'percentage', 30, 'percentage', 'all', 'none', 0, 20, true, 20, NOW()-interval '10 days', NOW()-interval '3 days', 'expired', NOW()-interval '10 days', NOW()-interval '3 days'),
  ('dc000001-0000-0000-0000-000000000006', sid, 'Holiday Special', 'HOLIDAY2026', 'percentage', 15, 'percentage', 'all', 'purchase_amount', 400000, 200, true, 0, NOW()+interval '30 days', NOW()+interval '45 days', 'scheduled', NOW()-interval '5 days', NOW()-interval '5 days')
ON CONFLICT (id) DO NOTHING;

-- ==============================
-- BLOG POSTS (5)
-- ==============================
INSERT INTO blog_posts (id, shop_id, title, slug, body_html, excerpt, author, tags, published, published_at, created_at, updated_at) VALUES
  ('b0000001-0000-0000-0000-000000000001', sid, 'Top 10 Acrylic Book Vases for Your Home Library', 'top-10-acrylic-book-vases', '<h2>Transform Your Bookshelf</h2><p>Acrylic book vases are the perfect blend of literature and art. Here are our top 10 picks for 2026...</p><p>From classic designs featuring The Great Gatsby to modern minimalist styles, there is something for every book lover.</p><h3>1. The Great Gatsby Collection</h3><p>Our bestseller for a reason. Available in both colorful and black editions.</p>', 'Discover the best acrylic book vases to elevate your home library decor in 2026.', 'Diep Anh', ARRAY['home-decor','book-vases','guide'], true, NOW()-interval '30 days', NOW()-interval '30 days', NOW()-interval '2 days'),
  ('b0000001-0000-0000-0000-000000000002', sid, 'How to Care for Your Acrylic Book Vase', 'how-to-care-acrylic-book-vase', '<h2>Keep Your Vase Looking New</h2><p>With proper care, your acrylic book vase will last for years. Follow these simple steps:</p><ul><li>Clean with a soft microfiber cloth</li><li>Avoid harsh chemicals</li><li>Keep away from direct sunlight</li><li>Use lukewarm water for stubborn marks</li></ul><p>Regular maintenance ensures your vase remains crystal clear and beautiful.</p>', 'Simple tips to maintain your acrylic book vase in pristine condition.', 'Diep Anh', ARRAY['care-guide','tips'], true, NOW()-interval '20 days', NOW()-interval '20 days', NOW()-interval '15 days'),
  ('b0000001-0000-0000-0000-000000000003', sid, 'Gift Ideas: Literary-Themed Home Decor', 'gift-ideas-literary-home-decor', '<h2>Perfect Gifts for Book Lovers</h2><p>Finding the right gift for the bibliophile in your life can be challenging. Our curated collection of literary-themed home decor makes it easy.</p><h3>Book Vases</h3><p>Our signature product line transforms beloved novels into stunning vases.</p><h3>Custom Orders</h3><p>We also accept custom orders for your favorite book titles.</p>', 'Find the perfect literary-themed gift for the book lover in your life.', 'Biblio Team', ARRAY['gifts','holiday','guide'], true, NOW()-interval '15 days', NOW()-interval '15 days', NOW()-interval '10 days'),
  ('b0000001-0000-0000-0000-000000000004', sid, 'Behind the Scenes: How We Make Our Book Vases', 'behind-the-scenes-making-book-vases', '<h2>From Design to Delivery</h2><p>Ever wondered how our beautiful acrylic book vases are made? Join us for a behind-the-scenes look at our workshop...</p><p>Each vase goes through 7 stages of production, from initial design to final quality check.</p>', 'A peek into our workshop and the craftsmanship behind every Biblio Bloom vase.', 'Diep Anh', ARRAY['behind-the-scenes','craftsmanship'], false, NULL, NOW()-interval '5 days', NOW()-interval '5 days'),
  ('b0000001-0000-0000-0000-000000000005', sid, 'Summer 2026 Collection Preview', 'summer-2026-collection-preview', '<h2>Coming Soon: Summer Collection</h2><p>We are excited to announce our upcoming Summer 2026 collection featuring 5 new literary classics reimagined as stunning acrylic vases.</p><p>Stay tuned for the official launch date!</p>', 'Sneak peek at our upcoming Summer 2026 collection of acrylic book vases.', 'Biblio Team', ARRAY['new-collection','summer','preview'], false, NULL, NOW()-interval '2 days', NOW()-interval '2 days')
ON CONFLICT (id) DO NOTHING;

-- ==============================
-- MENUS + MENU ITEMS
-- ==============================
INSERT INTO menus (id, shop_id, title, slug, created_at, updated_at) VALUES
  ('ae000001-0000-0000-0000-000000000001', sid, 'Main Navigation', 'main-menu', NOW()-interval '90 days', NOW()-interval '5 days'),
  ('ae000001-0000-0000-0000-000000000002', sid, 'Footer Menu', 'footer', NOW()-interval '90 days', NOW()-interval '10 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO menu_items (id, menu_id, parent_id, title, url, resource_type, position, created_at) VALUES
  ('af000001-0000-0000-0000-000000000001', 'ae000001-0000-0000-0000-000000000001', NULL, 'Home', '/', NULL, 1, NOW()-interval '90 days'),
  ('af000001-0000-0000-0000-000000000002', 'ae000001-0000-0000-0000-000000000001', NULL, 'Shop All', '/collections/all', 'collection', 2, NOW()-interval '90 days'),
  ('af000001-0000-0000-0000-000000000003', 'ae000001-0000-0000-0000-000000000001', NULL, 'Best Sellers', '/collections/best-sellers', 'collection', 3, NOW()-interval '90 days'),
  ('af000001-0000-0000-0000-000000000004', 'ae000001-0000-0000-0000-000000000001', NULL, 'New Arrivals', '/collections/new-arrivals', 'collection', 4, NOW()-interval '60 days'),
  ('af000001-0000-0000-0000-000000000005', 'ae000001-0000-0000-0000-000000000001', NULL, 'Blog', '/blogs', NULL, 5, NOW()-interval '30 days'),
  ('af000001-0000-0000-0000-000000000006', 'ae000001-0000-0000-0000-000000000001', NULL, 'About Us', '/pages/about', 'page', 6, NOW()-interval '90 days'),
  ('af000001-0000-0000-0000-000000000007', 'ae000001-0000-0000-0000-000000000001', NULL, 'Contact', '/pages/contact', 'page', 7, NOW()-interval '90 days'),
  -- Sub-items under "Shop All"
  ('af000001-0000-0000-0000-000000000008', 'ae000001-0000-0000-0000-000000000001', 'af000001-0000-0000-0000-000000000002', 'Colorful Collection', '/collections/colorful', 'collection', 1, NOW()-interval '60 days'),
  ('af000001-0000-0000-0000-000000000009', 'ae000001-0000-0000-0000-000000000001', 'af000001-0000-0000-0000-000000000002', 'Black Edition', '/collections/black-edition', 'collection', 2, NOW()-interval '60 days'),
  -- Footer
  ('af000001-0000-0000-0000-000000000010', 'ae000001-0000-0000-0000-000000000002', NULL, 'Privacy Policy', '/pages/privacy-policy', 'page', 1, NOW()-interval '90 days'),
  ('af000001-0000-0000-0000-000000000011', 'ae000001-0000-0000-0000-000000000002', NULL, 'Terms of Service', '/pages/terms', 'page', 2, NOW()-interval '90 days'),
  ('af000001-0000-0000-0000-000000000012', 'ae000001-0000-0000-0000-000000000002', NULL, 'Shipping Policy', '/pages/shipping', 'page', 3, NOW()-interval '90 days'),
  ('af000001-0000-0000-0000-000000000013', 'ae000001-0000-0000-0000-000000000002', NULL, 'Refund Policy', '/pages/refund', 'page', 4, NOW()-interval '90 days'),
  ('af000001-0000-0000-0000-000000000014', 'ae000001-0000-0000-0000-000000000002', NULL, 'Contact Us', '/pages/contact', 'page', 5, NOW()-interval '90 days')
ON CONFLICT (id) DO NOTHING;

-- ==============================
-- SHIPPING ZONES + RATES
-- ==============================
INSERT INTO shipping_zones (id, shop_id, name, countries, created_at, updated_at) VALUES
  ('5a000001-0000-0000-0000-000000000001', sid, 'Domestic (Vietnam)', '["VN"]', NOW()-interval '90 days', NOW()-interval '10 days'),
  ('5a000001-0000-0000-0000-000000000002', sid, 'Southeast Asia', '["TH","SG","MY","PH","ID","KH","LA","MM"]', NOW()-interval '90 days', NOW()-interval '10 days'),
  ('5a000001-0000-0000-0000-000000000003', sid, 'International', '["US","CA","GB","AU","JP","KR","FR","DE"]', NOW()-interval '60 days', NOW()-interval '10 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO shipping_rates (id, zone_id, name, price, type, min_value, max_value, created_at) VALUES
  ('5b000001-0000-0000-0000-000000000001', '5a000001-0000-0000-0000-000000000001', 'Standard (3-5 days)', 30000, 'price_based', 0, 499999, NOW()-interval '90 days'),
  ('5b000001-0000-0000-0000-000000000002', '5a000001-0000-0000-0000-000000000001', 'Free Shipping (500k+)', 0, 'price_based', 500000, NULL, NOW()-interval '90 days'),
  ('5b000001-0000-0000-0000-000000000003', '5a000001-0000-0000-0000-000000000001', 'Express (1-2 days)', 60000, 'price_based', 0, NULL, NOW()-interval '60 days'),
  ('5b000001-0000-0000-0000-000000000004', '5a000001-0000-0000-0000-000000000002', 'Standard SEA (5-7 days)', 150000, 'price_based', 0, NULL, NOW()-interval '90 days'),
  ('5b000001-0000-0000-0000-000000000005', '5a000001-0000-0000-0000-000000000002', 'Express SEA (3-4 days)', 250000, 'price_based', 0, NULL, NOW()-interval '60 days'),
  ('5b000001-0000-0000-0000-000000000006', '5a000001-0000-0000-0000-000000000003', 'Standard International (7-14 days)', 350000, 'price_based', 0, NULL, NOW()-interval '60 days'),
  ('5b000001-0000-0000-0000-000000000007', '5a000001-0000-0000-0000-000000000003', 'Express International (3-5 days)', 650000, 'price_based', 0, NULL, NOW()-interval '60 days')
ON CONFLICT (id) DO NOTHING;

-- ==============================
-- FILES (media library)
-- ==============================
INSERT INTO files (id, shop_id, filename, mime_type, size, url, alt, created_at) VALUES
  ('f1000001-0000-0000-0000-000000000001', sid, 'gatsby-vase-hero.jpg', 'image/jpeg', 2450000, '/uploads/diepanhtest/gatsby-vase-hero.jpg', 'The Great Gatsby Acrylic Book Vase - Hero Shot', NOW()-interval '90 days'),
  ('f1000001-0000-0000-0000-000000000002', sid, 'pride-prejudice-lifestyle.jpg', 'image/jpeg', 1800000, '/uploads/diepanhtest/pride-prejudice-lifestyle.jpg', 'Pride and Prejudice Vase in Living Room Setting', NOW()-interval '85 days'),
  ('f1000001-0000-0000-0000-000000000003', sid, 'collection-banner-summer.png', 'image/png', 3200000, '/uploads/diepanhtest/collection-banner-summer.png', 'Summer 2026 Collection Banner', NOW()-interval '30 days'),
  ('f1000001-0000-0000-0000-000000000004', sid, 'logo-biblio-bloom.svg', 'image/svg+xml', 45000, '/uploads/diepanhtest/logo-biblio-bloom.svg', 'Biblio Bloom Logo', NOW()-interval '90 days'),
  ('f1000001-0000-0000-0000-000000000005', sid, 'shipping-guide.pdf', 'application/pdf', 850000, '/uploads/diepanhtest/shipping-guide.pdf', 'Shipping Guide PDF', NOW()-interval '60 days'),
  ('f1000001-0000-0000-0000-000000000006', sid, 'product-catalog-2026.pdf', 'application/pdf', 5200000, '/uploads/diepanhtest/product-catalog-2026.pdf', 'Product Catalog 2026', NOW()-interval '45 days'),
  ('f1000001-0000-0000-0000-000000000007', sid, 'dracula-vase-detail.jpg', 'image/jpeg', 1600000, '/uploads/diepanhtest/dracula-vase-detail.jpg', 'Dracula Acrylic Book Vase Detail', NOW()-interval '75 days'),
  ('f1000001-0000-0000-0000-000000000008', sid, 'jane-eyre-vase-angle.jpg', 'image/jpeg', 2100000, '/uploads/diepanhtest/jane-eyre-vase-angle.jpg', 'Jane Eyre Vase Side Angle', NOW()-interval '70 days'),
  ('f1000001-0000-0000-0000-000000000009', sid, 'promo-video-thumb.jpg', 'image/jpeg', 980000, '/uploads/diepanhtest/promo-video-thumb.jpg', 'Promotional Video Thumbnail', NOW()-interval '20 days'),
  ('f1000001-0000-0000-0000-000000000010', sid, 'blog-header-care-guide.jpg', 'image/jpeg', 1350000, '/uploads/diepanhtest/blog-header-care-guide.jpg', 'Care Guide Blog Header Image', NOW()-interval '20 days')
ON CONFLICT (id) DO NOTHING;

-- ==============================
-- NOTIFICATIONS (10)
-- ==============================
INSERT INTO notifications (id, shop_id, user_id, type, title, message, read, resource_type, resource_id, created_at) VALUES
  ('ee000001-0000-0000-0000-000000000001', sid, uid, 'order', 'New Order #1012', 'Do Thanh Minh placed a new order for 1,950,000 VND', false, 'order', 'd0000001-0000-0000-0000-000000000012', NOW()-interval '1 day'),
  ('ee000001-0000-0000-0000-000000000002', sid, uid, 'order', 'New Order #1010', 'Guest buyer placed an order for 350,000 VND', false, 'order', 'd0000001-0000-0000-0000-000000000010', NOW()-interval '2 days'),
  ('ee000001-0000-0000-0000-000000000003', sid, uid, 'order', 'Payment Pending #1005', 'Order #1005 is awaiting payment confirmation', false, 'order', 'd0000001-0000-0000-0000-000000000005', NOW()-interval '1 day'),
  ('ee000001-0000-0000-0000-000000000004', sid, uid, 'customer', 'New Customer Registered', 'Yuki Tanaka created an account', true, 'customer', 'c0000001-0000-0000-0000-000000000012', NOW()-interval '35 days'),
  ('ee000001-0000-0000-0000-000000000005', sid, uid, 'product', 'Low Stock Alert', 'The Great Gatsby Acrylic Book Vase - Colorful has only 3 units left', false, 'product', p1, NOW()-interval '3 days'),
  ('ee000001-0000-0000-0000-000000000006', sid, uid, 'system', 'Theme Updated', 'Your storefront theme was updated successfully', true, NULL, NULL, NOW()-interval '10 days'),
  ('ee000001-0000-0000-0000-000000000007', sid, uid, 'order', 'Refund Processed #1007', 'Refund of 480,000 VND processed for order #1007', true, 'order', 'd0000001-0000-0000-0000-000000000007', NOW()-interval '20 days'),
  ('ee000001-0000-0000-0000-000000000008', sid, uid, 'system', 'Plan Upgrade Available', 'Your store has grown! Consider upgrading to the Pro plan for more features.', false, NULL, NULL, NOW()-interval '5 days'),
  ('ee000001-0000-0000-0000-000000000009', sid, uid, 'order', 'Order Cancelled #1011', 'Order #1011 from Mai Thu Loan has been cancelled', true, 'order', 'd0000001-0000-0000-0000-000000000011', NOW()-interval '17 days'),
  ('ee000001-0000-0000-0000-000000000010', sid, uid, 'customer', 'VIP Customer Alert', 'Pham Hong Dao has reached VIP status with 8 orders', true, 'customer', 'c0000001-0000-0000-0000-000000000004', NOW()-interval '7 days')
ON CONFLICT (id) DO NOTHING;

-- ==============================
-- ADDITIONAL PAGES (policy pages — skip 'about' as it already exists)
-- ==============================
INSERT INTO pages (id, shop_id, title, slug, body_html, published, created_at, updated_at) VALUES
  ('aa000001-0000-0000-0000-000000000002', sid, 'Privacy Policy', 'privacy-policy', '<h1>Privacy Policy</h1><p>Last updated: March 2026</p><p>Biblio Bloom operates the website and is committed to protecting your privacy.</p><h2>Information We Collect</h2><p>We collect information you provide when placing orders, creating accounts, or contacting us.</p><h2>How We Use Your Information</h2><p>Your information is used to process orders, communicate with you, and improve our services.</p>', true, NOW()-interval '90 days', NOW()-interval '60 days'),
  ('aa000001-0000-0000-0000-000000000003', sid, 'Shipping Policy', 'shipping', '<h1>Shipping Policy</h1><h2>Domestic Shipping (Vietnam)</h2><p>Standard: 3-5 business days (30,000 VND). Free shipping on orders over 500,000 VND.</p><h2>International Shipping</h2><p>Southeast Asia: 5-7 days. International: 7-14 days. Express options available.</p>', true, NOW()-interval '90 days', NOW()-interval '45 days'),
  ('aa000001-0000-0000-0000-000000000004', sid, 'Refund Policy', 'refund', '<h1>Refund and Return Policy</h1><h2>Returns</h2><p>We accept returns within 30 days of delivery for unused items in original packaging.</p><h2>Refunds</h2><p>Refunds are processed within 5-7 business days after receiving the returned item.</p>', true, NOW()-interval '90 days', NOW()-interval '45 days'),
  ('aa000001-0000-0000-0000-000000000005', sid, 'Terms of Service', 'terms', '<h1>Terms of Service</h1><p>By using Biblio Bloom, you agree to these terms.</p><h2>Orders</h2><p>All orders are subject to availability and confirmation.</p><h2>Intellectual Property</h2><p>All content on this website is owned by Biblio Bloom.</p>', true, NOW()-interval '90 days', NOW()-interval '45 days')
ON CONFLICT (id) DO NOTHING;

-- ==============================
-- SHOP SETTINGS (additional)
-- ==============================
INSERT INTO shop_settings (shop_id, key, value) VALUES
  (sid, 'store_currency', '"VND"'),
  (sid, 'store_timezone', '"Asia/Ho_Chi_Minh"'),
  (sid, 'checkout_settings', '{"require_phone":true,"allow_guest":true,"auto_archive_orders":false,"order_prefix":"BB"}'),
  (sid, 'tax_settings', '{"tax_included":true,"tax_rate":0.1,"tax_name":"VAT"}'),
  (sid, 'email_settings', '{"sender_name":"Biblio Bloom","sender_email":"hello@bibliobloom.vn","order_confirmation":true,"shipping_confirmation":true,"refund_notification":true}'),
  (sid, 'social_links', '{"facebook":"https://facebook.com/bibliobloom","instagram":"https://instagram.com/bibliobloom","tiktok":"https://tiktok.com/@bibliobloom","youtube":""}'),
  (sid, 'seo_settings', '{"meta_title":"Biblio Bloom - Acrylic Book Vases & Literary Home Decor","meta_description":"Transform your space with our handcrafted acrylic book vases. Literary-themed home decor for book lovers.","google_analytics_id":"G-XXXXXXXXXX","facebook_pixel_id":""}')
ON CONFLICT (shop_id, key) DO NOTHING;

-- ==============================
-- Update shop info for completeness
-- ==============================
UPDATE shops SET
  plan = 'basic',
  currency = 'VND'
WHERE id = sid;

-- Update customer order counts to match
UPDATE customers SET orders_count = 2, total_spent = 1550000 WHERE id = 'c0000001-0000-0000-0000-000000000001';
UPDATE customers SET orders_count = 1, total_spent = 350000  WHERE id = 'c0000001-0000-0000-0000-000000000002';
UPDATE customers SET orders_count = 2, total_spent = 2800000 WHERE id = 'c0000001-0000-0000-0000-000000000004';
UPDATE customers SET orders_count = 1, total_spent = 500000  WHERE id = 'c0000001-0000-0000-0000-000000000007';
UPDATE customers SET orders_count = 1, total_spent = 780000  WHERE id = 'c0000001-0000-0000-0000-000000000010';
UPDATE customers SET orders_count = 1, total_spent = 50      WHERE id = 'c0000001-0000-0000-0000-000000000011';
UPDATE customers SET orders_count = 1, total_spent = 550000  WHERE id = 'c0000001-0000-0000-0000-000000000014';
UPDATE customers SET orders_count = 2, total_spent = 2430000 WHERE id = 'c0000001-0000-0000-0000-000000000015';

RAISE NOTICE 'Seed data inserted successfully!';
END $$;
