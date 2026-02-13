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
      `SELECT doc_date, doc_time, doc_no, doc_ref, doc_ref_date, cust_code, lastedit_datetime,total_amount
       FROM ic_trans 
       WHERE trans_flag = 44 AND last_status = 0 AND cust_code = $1
       ORDER BY doc_date DESC, doc_time DESC
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
