const express = require('express');
const pool = require('../config/db');
const { authMiddleware, staffOnly } = require('../middleware/auth');

const router = express.Router();

/**
 * Helper: get cust_code based on role
 */
function getCustCode(req, paramCode) {
  if (req.user.role === 'staff') {
    return paramCode || req.query.cust_code;
  }
  return req.user.cust_code;
}

// GET /api/transactions/sales?cust_code=xxx&page=1&limit=20
router.get('/sales', authMiddleware, async (req, res) => {
  try {
    const custCode = getCustCode(req);
    if (!custCode) return res.status(400).json({ error: 'กรุณาระบุรหัสสมาชิก' });

    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM ic_trans WHERE trans_flag = 44 AND last_status = 0 AND cust_code = $1`,
      [custCode]
    );
    const total = parseInt(countRes.rows[0].count);

    const result = await pool.query(
      `SELECT ict.doc_date, ict.doc_time, ict.doc_no, ict.doc_ref, ict.doc_ref_date, ict.cust_code, ict.lastedit_datetime, ict.total_amount,
        COALESCE((
          SELECT balance_amount FROM (
            SELECT t1.doc_no, COALESCE(t1.total_amount,0) - (
              SELECT COALESCE(SUM(COALESCE(sum_pay_money,0)),0)
              FROM ap_ar_trans_detail apd1
              WHERE COALESCE(apd1.last_status,0)=0 AND apd1.trans_flag IN (239)
                AND t1.doc_no = apd1.billing_no
                AND t1.doc_date = apd1.billing_date
            ) AS balance_amount
            FROM ic_trans t1
            WHERE COALESCE(t1.last_status,0)=0 AND t1.trans_flag=44
              AND (t1.inquiry_type=0 OR t1.inquiry_type=2) AND t1.cust_code = ict.cust_code
            UNION ALL
            SELECT t2.doc_no, COALESCE(t2.total_amount,0) - (
              SELECT COALESCE(SUM(COALESCE(sum_pay_money,0)),0)
              FROM ap_ar_trans_detail apd2
              WHERE COALESCE(apd2.last_status,0)=0 AND apd2.trans_flag IN (239)
                AND t2.doc_no = apd2.billing_no
                AND t2.doc_date = apd2.billing_date
            ) AS balance_amount
            FROM ic_trans t2
            WHERE COALESCE(t2.last_status,0)=0
              AND (t2.trans_flag=46 OR t2.trans_flag=93 OR t2.trans_flag=99 OR t2.trans_flag=95 OR t2.trans_flag=101)
              AND t2.cust_code = ict.cust_code
            UNION ALL
            SELECT t3.doc_no, -1*(COALESCE(t3.total_amount,0) + (
              SELECT COALESCE(SUM(COALESCE(sum_pay_money,0)),0)
              FROM ap_ar_trans_detail apd3
              WHERE COALESCE(apd3.last_status,0)=0 AND apd3.trans_flag IN (239)
                AND t3.doc_no = apd3.billing_no
                AND t3.doc_date = apd3.billing_date
            )) AS balance_amount
            FROM ic_trans t3
            WHERE COALESCE(t3.last_status,0)=0
              AND ((t3.trans_flag=48 AND t3.inquiry_type IN (0,2,4)) OR t3.trans_flag=97 OR t3.trans_flag=103)
              AND t3.cust_code = ict.cust_code
          ) AS xx
          WHERE balance_amount <> 0 AND xx.doc_no = ap_ar.billing_no
          ORDER BY xx.doc_no LIMIT 1
        ), 0) AS balance,
        CASE
          WHEN cb.doc_no IS NOT NULL AND ict.total_amount = cb.total_amount THEN 'success'
          WHEN ap_ar.doc_no IS NOT NULL THEN 'success'
          WHEN ap_ar.doc_no IS NULL AND ap_inv.doc_no IS NOT NULL THEN 'payment'
          WHEN ict.last_status = 1 THEN 'cancel'
          ELSE 'pending'
        END AS status
       FROM ic_trans ict
       LEFT JOIN cb_trans cb ON cb.doc_no = ict.doc_no AND cb.trans_flag = 44
       LEFT JOIN ap_ar_trans_detail ap_inv ON ap_inv.billing_no = ict.doc_no AND ap_inv.trans_flag = 44
       LEFT JOIN ap_ar_trans_detail ap_ar ON ap_ar.billing_no = ict.doc_no AND ap_ar.trans_flag = 239
       WHERE ict.trans_flag = 44 AND ict.last_status = 0 AND ict.cust_code = $1
       ORDER BY ict.doc_date DESC, ict.doc_time DESC
       LIMIT $2 OFFSET $3`,
      [custCode, limit, offset]
    );

    res.json({ data: result.rows, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Sales list error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// GET /api/transactions/sales/:docNo/detail
router.get('/sales/:docNo/detail', authMiddleware, async (req, res) => {
  try {
    const custCode = getCustCode(req);

    // Verify access
    const headerRes = await pool.query(
      `SELECT doc_date, doc_time, doc_no, doc_ref, cust_code, lastedit_datetime,total_amount,total_vat_value,total_discount
       FROM ic_trans WHERE doc_no = $1 AND trans_flag = 44 AND last_status = 0`,
      [req.params.docNo]
    );

    if (headerRes.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบเอกสาร' });
    }

    if (req.user.role === 'member' && headerRes.rows[0].cust_code !== custCode) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึง' });
    }

    const detailRes = await pool.query(
      `SELECT barcode, item_code, item_name, unit_code, qty, price, sum_amount
       FROM ic_trans_detail 
       WHERE doc_no = $1 AND trans_flag = 44
       ORDER BY item_code`,
      [req.params.docNo]
    );

    res.json({ header: headerRes.rows[0], details: detailRes.rows });
  } catch (err) {
    console.error('Sale detail error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// GET /api/transactions/returns?cust_code=xxx
router.get('/returns', authMiddleware, async (req, res) => {
  try {
    const custCode = getCustCode(req);
    if (!custCode) return res.status(400).json({ error: 'กรุณาระบุรหัสสมาชิก' });

    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM ic_trans WHERE trans_flag = 48 AND last_status = 0 AND cust_code = $1`,
      [custCode]
    );
    const total = parseInt(countRes.rows[0].count);

    const result = await pool.query(
      `SELECT doc_date, doc_time, doc_no, doc_ref, doc_ref_date, cust_code, lastedit_datetime,total_amount
       FROM ic_trans 
       WHERE trans_flag = 48 AND last_status = 0 AND cust_code = $1
       ORDER BY doc_date DESC, doc_time DESC
       LIMIT $2 OFFSET $3`,
      [custCode, limit, offset]
    );

    res.json({ data: result.rows, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Returns list error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// GET /api/transactions/returns/:docNo/detail
router.get('/returns/:docNo/detail', authMiddleware, async (req, res) => {
  try {
    const custCode = getCustCode(req);

    const headerRes = await pool.query(
      `SELECT doc_date, doc_time, doc_no, doc_ref, cust_code, lastedit_datetime,total_amount,total_vat_value,total_discount
       FROM ic_trans WHERE doc_no = $1 AND trans_flag = 48 AND last_status = 0`,
      [req.params.docNo]
    );

    if (headerRes.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบเอกสาร' });
    }

    if (req.user.role === 'member' && headerRes.rows[0].cust_code !== custCode) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึง' });
    }

    const detailRes = await pool.query(
      `SELECT barcode, item_code, item_name, unit_code, qty, price, sum_amount
       FROM ic_trans_detail 
       WHERE doc_no = $1 AND trans_flag = 48
       ORDER BY item_code`,
      [req.params.docNo]
    );

    res.json({ header: headerRes.rows[0], details: detailRes.rows });
  } catch (err) {
    console.error('Return detail error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

module.exports = router;
