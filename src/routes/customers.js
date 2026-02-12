const express = require('express');
const pool = require('../config/db');
const { authMiddleware, staffOnly } = require('../middleware/auth');

const router = express.Router();

// GET /api/customers/me - member views own info
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const custCode = req.user.cust_code;
    if (!custCode) {
      return res.status(400).json({ error: 'ไม่มีข้อมูลสมาชิก' });
    }

    const result = await pool.query(
      'SELECT code, name_1, point_balance, reward_point FROM ar_customer WHERE code = $1',
      [custCode]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบข้อมูลสมาชิก' });
    }

    res.json({ customer: result.rows[0] });
  } catch (err) {
    console.error('Customer me error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// GET /api/customers/search?q=xxx - staff search customers
router.get('/search', authMiddleware, staffOnly, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 1) {
      return res.status(400).json({ error: 'กรุณาระบุคำค้นหา' });
    }

    const result = await pool.query(
      `SELECT code, name_1, point_balance, reward_point 
       FROM ar_customer 
       WHERE code ILIKE $1 OR name_1 ILIKE $1
       ORDER BY code
       LIMIT 50`,
      [`%${q}%`]
    );

    res.json({ customers: result.rows });
  } catch (err) {
    console.error('Customer search error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// GET /api/customers/:code - staff view specific customer
router.get('/:code', authMiddleware, staffOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT code, name_1, point_balance, reward_point FROM ar_customer WHERE code = $1',
      [req.params.code]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบข้อมูลสมาชิก' });
    }

    res.json({ customer: result.rows[0] });
  } catch (err) {
    console.error('Customer get error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

module.exports = router;
