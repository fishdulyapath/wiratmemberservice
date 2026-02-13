-- ============================================================
-- Loyalty Point System - Additional Tables
-- (ic_trans, ic_trans_detail, ar_customer, ic_size, ic_size_use 
--  are assumed to already exist in the database)
-- ============================================================

-- Point Transaction Header
CREATE TABLE IF NOT EXISTS mb_point_trans (
    roworder serial,
    doc_date DATE NOT NULL,
    doc_time VARCHAR(5),
    doc_no VARCHAR(25) NOT NULL,
    doc_no_sale VARCHAR(25),
    doc_no_return VARCHAR(25),
    cust_code VARCHAR(25) NOT NULL,
    sum_sale_amount NUMERIC DEFAULT 0,
    sum_return_amount NUMERIC DEFAULT 0,
    sum_total_amount NUMERIC DEFAULT 0,
    get_point NUMERIC DEFAULT 0,
    return_point NUMERIC DEFAULT 0,
    use_point NUMERIC DEFAULT 0,
    remark VARCHAR(255),
    lastedit_datetime TIMESTAMP WITHOUT TIME ZONE,
    PRIMARY KEY (doc_no)
);

-- Point Transaction Detail (เก็บรายการสินค้า ไม่เก็บแต้ม — แต้มอยู่ที่ header)
CREATE TABLE IF NOT EXISTS mb_point_trans_detail (
    roworder serial,
    doc_date DATE NOT NULL,
    doc_no VARCHAR(25) NOT NULL,
    cust_code VARCHAR(25) NOT NULL,
    barcode VARCHAR(25),
    item_code VARCHAR(25),
    item_name VARCHAR(255),
    unit_code VARCHAR(25),
    qty NUMERIC DEFAULT 0,
    price NUMERIC DEFAULT 0,
    sale_amount NUMERIC DEFAULT 0,
    return_amount NUMERIC DEFAULT 0,
    total_amount NUMERIC DEFAULT 0,
    remark VARCHAR(255),
    lastedit_datetime TIMESTAMP WITHOUT TIME ZONE,
    PRIMARY KEY (roworder)
);

CREATE INDEX IF NOT EXISTS idx_mb_point_trans_cust ON mb_point_trans(cust_code);
CREATE INDEX IF NOT EXISTS idx_mb_point_trans_date ON mb_point_trans(doc_date);
CREATE INDEX IF NOT EXISTS idx_mb_point_trans_detail_docno ON mb_point_trans_detail(doc_no);
CREATE INDEX IF NOT EXISTS idx_mb_point_trans_detail_cust ON mb_point_trans_detail(cust_code);

-- Point calculation tracking (to know which ic_trans docs have been processed)
CREATE TABLE IF NOT EXISTS mb_point_calc_log (
    roworder serial,
    doc_no VARCHAR(25) NOT NULL,
    trans_flag INTEGER NOT NULL,
    lastedit_datetime TIMESTAMP WITHOUT TIME ZONE,
    calc_datetime TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (doc_no, trans_flag)
);

-- Running doc_no sequence for point transactions
CREATE SEQUENCE IF NOT EXISTS mb_point_doc_seq START 1;

-- Point Period Config (กำหนดช่วงวันที่ที่ให้แต้ม)
CREATE TABLE IF NOT EXISTS mb_point_period (
    id SERIAL PRIMARY KEY,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_active BOOLEAN DEFAULT true,
    remark VARCHAR(255),
    created_by VARCHAR(100),
    lastedit_datetime TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

ALTER TABLE ar_customer
  ADD COLUMN IF NOT EXISTS reward_point numeric DEFAULT 0;

-- ข้อมูลตัวอย่าง: ช่วงวันที่ให้แต้มปี 2026
INSERT INTO mb_point_period (start_date, end_date, is_active, remark, created_by)
SELECT '2026-01-01', '2026-12-31', true, 'ช่วงให้แต้มปี 2026', 'system'
WHERE NOT EXISTS (SELECT 1 FROM mb_point_period WHERE start_date = '2026-01-01' AND end_date = '2026-12-31');

-- ============================================================
-- ไม่ต้องสร้างตาราง user แยก — ใช้ตารางจากระบบเดิม:
--   ar_customer = สมาชิก (member)
--     code = username, country = password, name_1 = ชื่อ
--   erp_user = พนักงาน (staff)
--     code = username, password = password, name_1 = ชื่อ
-- ============================================================
