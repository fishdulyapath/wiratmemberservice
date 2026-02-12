const express = require('express');
const pool = require('../config/db');
const { authMiddleware, staffOnly } = require('../middleware/auth');

const router = express.Router();

// GET /api/point-config — ดึง list ทั้งหมด
router.get('/', authMiddleware, staffOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, start_date, end_date, is_active, remark, created_by, lastedit_datetime
       FROM mb_point_period
       ORDER BY start_date DESC`
    );
    res.json({ periods: result.rows });
  } catch (err) {
    console.error('Point config list error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// POST /api/point-config — สร้าง period ใหม่
router.post('/', authMiddleware, staffOnly, async (req, res) => {
  try {
    const { start_date, end_date, remark } = req.body;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'กรุณาระบุวันที่เริ่มต้นและวันที่สิ้นสุด' });
    }
    if (new Date(start_date) > new Date(end_date)) {
      return res.status(400).json({ error: 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด' });
    }

    const result = await pool.query(
      `INSERT INTO mb_point_period (start_date, end_date, remark, created_by, lastedit_datetime)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, start_date, end_date, is_active, remark, created_by, lastedit_datetime`,
      [start_date, end_date, remark || null, req.user.username]
    );

    res.status(201).json({ period: result.rows[0] });
  } catch (err) {
    console.error('Point config create error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// PUT /api/point-config/:id — แก้ไข period
router.put('/:id', authMiddleware, staffOnly, async (req, res) => {
  try {
    const { start_date, end_date, is_active, remark } = req.body;
    if (start_date && end_date && new Date(start_date) > new Date(end_date)) {
      return res.status(400).json({ error: 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด' });
    }

    const result = await pool.query(
      `UPDATE mb_point_period
       SET start_date = COALESCE($1, start_date),
           end_date = COALESCE($2, end_date),
           is_active = COALESCE($3, is_active),
           remark = COALESCE($4, remark),
           lastedit_datetime = NOW()
       WHERE id = $5
       RETURNING id, start_date, end_date, is_active, remark, created_by, lastedit_datetime`,
      [start_date || null, end_date || null, is_active != null ? is_active : null, remark != null ? remark : null, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบข้อมูล' });
    }

    res.json({ period: result.rows[0] });
  } catch (err) {
    console.error('Point config update error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// DELETE /api/point-config/:id — ลบ period
router.delete('/:id', authMiddleware, staffOnly, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM mb_point_period WHERE id = $1 RETURNING id',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบข้อมูล' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Point config delete error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

module.exports = router;
