const express = require('express');
const pool = require('../config/db');
const { authMiddleware, staffOnly } = require('../middleware/auth');
const pointCalcService = require('../services/pointCalcService');

const router = express.Router();

function getCustCode(req) {
  if (req.user.role === 'staff') {
    return req.query.cust_code || req.body.cust_code;
  }
  return req.user.cust_code;
}

// GET /api/points/movement?cust_code=xxx&page=1
// Point movement history (all point transactions)
router.get('/movement', authMiddleware, async (req, res) => {
  try {
    const custCode = getCustCode(req);
    if (!custCode) return res.status(400).json({ error: 'กรุณาระบุรหัสสมาชิก' });

    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const countRes = await pool.query(
      'SELECT COUNT(*) FROM mb_point_trans WHERE cust_code = $1',
      [custCode]
    );
    const total = parseInt(countRes.rows[0].count);

    const result = await pool.query(
      `SELECT doc_date, doc_time, doc_no, doc_no_sale, doc_no_return, cust_code,
              sum_sale_amount, sum_return_amount, sum_total_amount,
              get_point, use_point, remark, lastedit_datetime
       FROM mb_point_trans
       WHERE cust_code = $1
       ORDER BY doc_date DESC, doc_time DESC, doc_no DESC
       LIMIT $2 OFFSET $3`,
      [custCode, limit, offset]
    );

    res.json({ data: result.rows, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Point movement error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// GET /api/points/movement/:docNo/detail
router.get('/movement/:docNo/detail', authMiddleware, async (req, res) => {
  try {
    const custCode = getCustCode(req);

    const headerRes = await pool.query(
      `SELECT doc_date, doc_time, doc_no, doc_no_sale, doc_no_return, cust_code,
              sum_sale_amount, sum_return_amount, sum_total_amount,
              get_point, use_point, remark, lastedit_datetime
       FROM mb_point_trans WHERE doc_no = $1`,
      [req.params.docNo]
    );

    if (headerRes.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบเอกสาร' });
    }

    if (req.user.role === 'member' && headerRes.rows[0].cust_code !== custCode) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึง' });
    }

    const detailRes = await pool.query(
      `SELECT barcode, item_code, item_name, unit_code, qty, price,
              sale_amount, return_amount, total_amount, get_point, remark
       FROM mb_point_trans_detail
       WHERE doc_no = $1
       ORDER BY item_code`,
      [req.params.docNo]
    );

    res.json({ header: headerRes.rows[0], details: detailRes.rows });
  } catch (err) {
    console.error('Point detail error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// POST /api/points/add - Staff adds points directly to a customer
router.post('/add', authMiddleware, staffOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const { cust_code, points, remark } = req.body;
    if (!cust_code || !points || points <= 0) {
      return res.status(400).json({ error: 'กรุณาระบุรหัสสมาชิกและจำนวนแต้ม' });
    }

    // Verify customer exists
    const custRes = await client.query(
      'SELECT code, name_1 FROM ar_customer WHERE code = $1',
      [cust_code]
    );
    if (custRes.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบสมาชิก' });
    }

    await client.query('BEGIN');

    const docNo = await pointCalcService.generateDocNo(client);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    await client.query(
      `INSERT INTO mb_point_trans 
       (doc_date, doc_time, doc_no, doc_no_sale, doc_no_return, cust_code,
        sum_sale_amount, sum_return_amount, sum_total_amount,
        get_point, use_point, remark, lastedit_datetime)
       VALUES ($1,$2,$3,NULL,NULL,$4,0,0,0,$5,0,$6,$7)`,
      [today, time, docNo, cust_code, points, remark || `เพิ่มแต้มโดยพนักงาน ${req.user.username}`, now]
    );

    await pointCalcService.updateCustomerPoints(client, cust_code);
    await client.query('COMMIT');

    // Get updated balance
    const updatedRes = await pool.query(
      'SELECT point_balance, reward_point FROM ar_customer WHERE code = $1',
      [cust_code]
    );

    res.json({
      success: true,
      doc_no: docNo,
      points_added: points,
      customer: updatedRes.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Add points error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  } finally {
    client.release();
  }
});

// POST /api/points/use - Staff uses (redeems) points for a customer
router.post('/use', authMiddleware, staffOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const { cust_code, points, remark } = req.body;
    if (!cust_code || !points || points <= 0) {
      return res.status(400).json({ error: 'กรุณาระบุรหัสสมาชิกและจำนวนแต้ม' });
    }

    // Check balance
    const custRes = await client.query(
      'SELECT code, name_1, point_balance FROM ar_customer WHERE code = $1',
      [cust_code]
    );
    if (custRes.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบสมาชิก' });
    }

    const balance = parseFloat(custRes.rows[0].point_balance) || 0;
    if (points > balance) {
      return res.status(400).json({ error: `แต้มไม่เพียงพอ (คงเหลือ ${balance})` });
    }

    await client.query('BEGIN');

    const docNo = await pointCalcService.generateDocNo(client);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    await client.query(
      `INSERT INTO mb_point_trans
       (doc_date, doc_time, doc_no, doc_no_sale, doc_no_return, cust_code,
        sum_sale_amount, sum_return_amount, sum_total_amount,
        get_point, use_point, remark, lastedit_datetime)
       VALUES ($1,$2,$3,NULL,NULL,$4,0,0,0,0,$5,$6,$7)`,
      [today, time, docNo, cust_code, points, remark || `ใช้แต้มโดยพนักงาน ${req.user.username}`, now]
    );

    await pointCalcService.updateCustomerPoints(client, cust_code);
    await client.query('COMMIT');

    const updatedRes = await pool.query(
      'SELECT point_balance, reward_point FROM ar_customer WHERE code = $1',
      [cust_code]
    );

    res.json({
      success: true,
      doc_no: docNo,
      points_used: points,
      customer: updatedRes.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Use points error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  } finally {
    client.release();
  }
});

// POST /api/points/cancel-use - Staff cancels a point usage (refund)
router.post('/cancel-use', authMiddleware, staffOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const { doc_no } = req.body;
    if (!doc_no) {
      return res.status(400).json({ error: 'กรุณาระบุเลขที่เอกสาร' });
    }

    // Find the original use transaction
    const origRes = await client.query(
      `SELECT doc_no, cust_code, use_point, remark FROM mb_point_trans 
       WHERE doc_no = $1 AND use_point > 0`,
      [doc_no]
    );

    if (origRes.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบเอกสารการใช้แต้ม' });
    }

    const orig = origRes.rows[0];

    await client.query('BEGIN');

    // Create a reversal transaction (negative use_point to refund)
    const newDocNo = await pointCalcService.generateDocNo(client);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    await client.query(
      `INSERT INTO mb_point_trans
       (doc_date, doc_time, doc_no, doc_no_sale, doc_no_return, cust_code,
        sum_sale_amount, sum_return_amount, sum_total_amount,
        get_point, use_point, remark, lastedit_datetime)
       VALUES ($1,$2,$3,NULL,NULL,$4,0,0,0,0,$5,$6,$7)`,
      [today, time, newDocNo, orig.cust_code,
       -parseFloat(orig.use_point),
       `ยกเลิกการใช้แต้ม อ้างอิง ${doc_no} โดยพนักงาน ${req.user.username}`,
       now]
    );

    await pointCalcService.updateCustomerPoints(client, orig.cust_code);
    await client.query('COMMIT');

    const updatedRes = await pool.query(
      'SELECT point_balance, reward_point FROM ar_customer WHERE code = $1',
      [orig.cust_code]
    );

    res.json({
      success: true,
      doc_no: newDocNo,
      points_refunded: parseFloat(orig.use_point),
      customer: updatedRes.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Cancel use points error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  } finally {
    client.release();
  }
});

// POST /api/points/recalc - Staff recalculates points for a customer
router.post('/recalc', authMiddleware, staffOnly, async (req, res) => {
  try {
    const { cust_code } = req.body;
    if (!cust_code) {
      return res.status(400).json({ error: 'กรุณาระบุรหัสสมาชิก' });
    }

    const result = await pointCalcService.recalcCustomer(cust_code);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Recalc error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// POST /api/points/process-all - Staff triggers manual point processing
router.post('/process-all', authMiddleware, staffOnly, async (req, res) => {
  try {
    const result = await pointCalcService.processAllDocs();
    res.json(result);
  } catch (err) {
    console.error('Process all error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

module.exports = router;
