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

// GET /api/customers/getCustomerCreditDetail - customer credit detail
router.get('/getCustomerCreditDetail', authMiddleware, async (req, res) => {
  try {
    const custCode = (req.query.cust_code || '').trim();
    if (!custCode) {
      return res.json({ success: false });
    }

    const client = await pool.connect();
    try {
      // Query 1: head data
      const query1 = `
        SELECT code, name_1,
          COALESCE((SELECT credit_money FROM ar_customer_detail WHERE ar_customer_detail.ar_code = ar_customer.code), 0) AS credit_money,
          COALESCE((SELECT credit_money_max FROM ar_customer_detail WHERE ar_customer_detail.ar_code = ar_customer.code), 0) AS credit_money_max,
          COALESCE((SELECT credit_status FROM ar_customer_detail WHERE ar_customer_detail.ar_code = ar_customer.code), 0) AS credit_status,
          (SELECT COALESCE(SUM(amount), 0) FROM (
            SELECT roworder, 1 AS calc_type, doc_no, cust_code, total_amount AS amount FROM ic_trans
              WHERE last_status = 0 AND ((trans_flag = 418 OR trans_flag = 44 OR trans_flag = 250) AND inquiry_type IN (0, 2))
              AND ar_customer.code = ic_trans.cust_code
            UNION ALL SELECT roworder, 1 AS calc_type, doc_no, cust_code, total_amount AS amount FROM ic_trans
              WHERE last_status = 0 AND (trans_flag IN (93, 99))
              AND ar_customer.code = ic_trans.cust_code
            UNION ALL SELECT roworder, 2 AS calc_type, doc_no, cust_code, total_amount AS amount FROM ic_trans
              WHERE last_status = 0 AND (trans_flag IN (46, 95, 101))
              AND ar_customer.code = ic_trans.cust_code
            UNION ALL SELECT roworder, 3 AS calc_type, doc_no, cust_code, -1 * total_amount AS amount FROM ic_trans
              WHERE last_status = 0 AND (trans_flag = 48 AND inquiry_type IN (0, 2, 4))
              AND ar_customer.code = ic_trans.cust_code
            UNION ALL SELECT roworder, 3 AS calc_type, doc_no, cust_code, -1 * total_amount AS amount FROM ic_trans
              WHERE last_status = 0 AND (trans_flag IN (97, 103, 252))
              AND ar_customer.code = ic_trans.cust_code
            UNION ALL SELECT roworder, 4 AS calc_type, doc_no, cust_code, -1 * total_net_value AS amount FROM ap_ar_trans
              WHERE last_status = 0 AND trans_flag = 239
              AND ar_customer.code = ap_ar_trans.cust_code
          ) AS temp6) AS balance_end,
          0 AS chq_outstanding, 0 AS sr_remain, 0 AS ss_remain, 0 AS advance_amount,
          COALESCE((SELECT close_reason FROM ar_customer_detail WHERE ar_customer_detail.ar_code = ar_customer.code), '') AS close_reason,
          (SELECT close_reason_1 FROM ar_customer_detail WHERE ar_customer_detail.ar_code = ar_customer.code) AS close_reason_1,
          (SELECT close_reason_2 FROM ar_customer_detail WHERE ar_customer_detail.ar_code = ar_customer.code) AS close_reason_2,
          (SELECT close_reason_3 FROM ar_customer_detail WHERE ar_customer_detail.ar_code = ar_customer.code) AS close_reason_3,
          (SELECT close_reason_4 FROM ar_customer_detail WHERE ar_customer_detail.ar_code = ar_customer.code) AS close_reason_4,
          (SELECT close_credit_date FROM ar_customer_detail WHERE ar_customer_detail.ar_code = ar_customer.code) AS close_credit_date
        FROM ar_customer
        WHERE COALESCE((SELECT credit_money FROM ar_customer_detail WHERE ar_customer_detail.ar_code = ar_customer.code), 0) > 0
          AND code = $1`;

      const result1 = await client.query(query1, [custCode]);

      const dataHead = { credit_money: '0', balance_end: '0' };
      if (result1.rows.length > 0) {
        const row = result1.rows[result1.rows.length - 1];
        dataHead.credit_money = Number(row.credit_money).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        dataHead.balance_end = Number(row.balance_end).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }

      // Query 2: transaction detail (data_1)
      const query2 = `
        SELECT * FROM (
          SELECT cust_code AS ar_code, doc_no, doc_date, due_date, amount, doc_type,
            used_status AS status, balance_amount AS ar_balance, ref_doc_no, ref_doc_date,
            branch_code, tax_doc_no, tax_doc_date, remark
          FROM (
            SELECT cust_code, doc_date,
              CASE WHEN (trans_flag IN (93, 95, 97)) THEN due_date WHEN (trans_flag = 418) THEN doc_date ELSE credit_date END AS due_date,
              doc_no, trans_flag AS doc_type, used_status, tax_doc_no, tax_doc_date, credit_day,
              doc_ref AS ref_doc_no, doc_ref_date AS ref_doc_date,
              COALESCE(total_amount, 0) AS amount,
              COALESCE(total_amount, 0) - (
                SELECT COALESCE(SUM(COALESCE(sum_pay_money, 0) + COALESCE(lost_profit_exchange_amount, 0)), 0)
                FROM ap_ar_trans_detail
                WHERE COALESCE(last_status, 0) = 0 AND trans_flag IN (239)
                  AND ic_trans.doc_no = ap_ar_trans_detail.billing_no
                  AND ic_trans.trans_flag = ap_ar_trans_detail.bill_type
                  AND doc_date <= DATE('2035-11-11')
              ) AS balance_amount,
              branch_code, remark
            FROM ic_trans
            WHERE COALESCE(last_status, 0) = 0 AND trans_flag = 44 AND (inquiry_type = 0 OR inquiry_type = 2)
              AND doc_date <= DATE('2035-11-11') AND cust_code = $1

            UNION ALL
            SELECT cust_code, doc_date,
              CASE WHEN (trans_flag IN (93, 95, 97)) THEN due_date WHEN (trans_flag = 418) THEN doc_date ELSE credit_date END AS due_date,
              doc_no, trans_flag AS doc_type, used_status, tax_doc_no, tax_doc_date, credit_day,
              CASE WHEN (trans_flag IN (14, 81, 83, 85, 93, 95, 97, 315, 260)) THEN doc_ref ELSE '' END AS ref_doc_no,
              CASE WHEN (trans_flag IN (14, 81, 83, 85, 93, 95, 97, 315, 260)) THEN doc_ref_date ELSE NULL END AS ref_doc_date,
              COALESCE(total_amount, 0) AS amount,
              COALESCE(total_amount, 0) - (
                SELECT COALESCE(SUM(COALESCE(sum_pay_money, 0)), 0)
                FROM ap_ar_trans_detail
                WHERE COALESCE(last_status, 0) = 0 AND trans_flag IN (239)
                  AND ic_trans.doc_no = ap_ar_trans_detail.billing_no
                  AND ic_trans.trans_flag = ap_ar_trans_detail.bill_type
                  AND doc_date <= DATE('2035-11-11')
              ) AS balance_amount,
              branch_code, remark
            FROM ic_trans
            WHERE COALESCE(last_status, 0) = 0
              AND (trans_flag = 46 OR trans_flag = 93 OR trans_flag = 99 OR trans_flag = 95
                OR trans_flag = 101 OR trans_flag = 418 OR ((trans_flag = 250 OR trans_flag = 254) AND (inquiry_type IN (0, 2))))
              AND doc_date <= DATE('2035-11-11') AND cust_code = $1

            UNION ALL
            SELECT cust_code, doc_date,
              CASE WHEN (trans_flag IN (93, 95, 97)) THEN due_date WHEN (trans_flag = 418) THEN doc_date ELSE credit_date END AS due_date,
              doc_no, trans_flag AS doc_type, used_status, tax_doc_no, tax_doc_date, credit_day,
              CASE WHEN (trans_flag IN (16, 81, 83, 85, 93, 95, 97, 315, 260)) THEN doc_ref ELSE '' END AS ref_doc_no,
              CASE WHEN (trans_flag IN (16, 81, 83, 85, 93, 95, 97, 315, 260)) THEN doc_ref_date ELSE NULL END AS ref_doc_date,
              -1 * COALESCE(total_amount, 0) AS amount,
              -1 * (COALESCE(total_amount, 0) + (
                SELECT COALESCE(SUM(COALESCE(sum_pay_money, 0)), 0)
                FROM ap_ar_trans_detail
                WHERE COALESCE(last_status, 0) = 0 AND trans_flag IN (239)
                  AND ic_trans.doc_no = ap_ar_trans_detail.billing_no
                  AND ic_trans.trans_flag = ap_ar_trans_detail.bill_type
                  AND doc_date <= DATE('2035-11-11')
              )) AS balance_amount,
              branch_code, remark
            FROM ic_trans
            WHERE COALESCE(last_status, 0) = 0
              AND ((trans_flag = 48 AND inquiry_type IN (0, 2, 4)) OR trans_flag = 97 OR (trans_flag = 252 AND inquiry_type IN (0, 2)) OR trans_flag = 103)
              AND doc_date <= DATE('2035-11-11') AND cust_code = $1

            UNION ALL
            SELECT cust_code, doc_date, due_date, doc_no, trans_flag AS doc_type, used_status, tax_doc_no, tax_doc_date, credit_day,
              '' AS ref_doc_no, NULL AS ref_doc_date,
              COALESCE(total_amount, 0) AS amount,
              COALESCE(total_amount, 0) - (
                SELECT COALESCE(SUM(COALESCE(sum_pay_money, 0) + COALESCE(lost_profit_exchange_amount, 0)), 0)
                FROM ap_ar_trans_detail
                WHERE COALESCE(last_status, 0) = 0 AND trans_flag IN (239)
                  AND ic_trans.doc_no = ap_ar_trans_detail.billing_no
                  AND ic_trans.trans_flag = ap_ar_trans_detail.bill_type
              ) AS balance_amount,
              branch_code, remark
            FROM as_trans AS ic_trans
            WHERE trans_flag = 1802 AND inquiry_type IN (0, 2) AND doc_date <= DATE('2035-11-11')
          ) AS xdoc
          WHERE balance_amount <> 0 AND cust_code = $1
        ) AS outer_query`;

      const result2 = await client.query(query2, [custCode]);

      let sumStatus = 0;
      const data1 = result2.rows.map(row => {
        sumStatus += Number(row.amount);
        return {
          doc_date: row.doc_date,
          doc_no: row.doc_no,
          due_date: row.due_date,
          doc_type: row.doc_type,
          amount: row.amount,
          ar_balance: row.ar_balance,
          remark: row.remark
        };
      });

      // Query 3: cheque list (data_2)
      const query3 = `
        SELECT chq_number, chq_get_date, doc_ref, chq_due_date, amount,
          (CASE
            WHEN (status = 0) THEN 'เช็คในมือ'
            WHEN (status = 1) THEN 'เช็คนำฝาก'
            WHEN (status = 2) THEN 'เช็คผ่าน'
            WHEN (status = 3) THEN 'เช็ครับคืน'
            WHEN (status = 4) THEN 'เช็คยกเลิก'
            WHEN (status = 5) THEN 'เช็คขายลด'
            WHEN (status = 6) THEN 'เช็คคืนนำเข้าใหม่'
            WHEN (status = 7) THEN 'เช็คเปลี่ยน'
            ELSE '' END) AS status
        FROM cb_chq_list
        WHERE chq_type = 1 AND status != 2 AND status != 8 AND status != 7 AND ap_ar_code = $1`;

      const result3 = await client.query(query3, [custCode]);

      let sumCheque = 0;
      const data2 = result3.rows.map(row => {
        sumCheque += Number(row.amount);
        return {
          chq_number: row.chq_number,
          chq_get_date: row.chq_get_date,
          doc_ref: row.doc_ref,
          chq_due_date: row.chq_due_date,
          amount: row.amount,
          status: row.status
        };
      });

      // Query 4: SO/SR documents (data_3)
      const query4 = `
        SELECT * FROM (
          SELECT doc_no, doc_date, trans_flag,
            COALESCE(remark, '') AS remark,
            (total_amount - COALESCE((
              SELECT SUM(sum_amount) FROM ic_trans_detail AS x
              WHERE x.trans_flag IN (44, 39, 36)
                AND x.last_status = 0 AND x.ref_doc_no = ic_trans.doc_no
            ), 0)) AS total_amount
          FROM ic_trans
          WHERE trans_flag = 34 AND last_status = 0 AND inquiry_type IN (0, 2)
            AND doc_success = 0 AND approve_status IN (0, 1) AND ic_trans.cust_code = $1

          UNION ALL
          SELECT doc_no, doc_date, trans_flag,
            COALESCE(remark, '') AS remark,
            (total_amount - COALESCE((
              SELECT SUM(sum_amount) FROM ic_trans_detail AS x
              WHERE x.trans_flag IN (44, 37)
                AND x.last_status = 0 AND x.ref_doc_no = ic_trans.doc_no
            ), 0)) AS total_amount
          FROM ic_trans
          WHERE trans_flag = 36 AND last_status = 0 AND inquiry_type IN (0, 2)
            AND doc_success = 0 AND approve_status IN (0, 1) AND ic_trans.cust_code = $1
        ) AS temp1
        WHERE temp1.total_amount > 0
        ORDER BY doc_date, doc_no`;

      const result4 = await client.query(query4, [custCode]);

      let sumSr = 0;
      let sumSS = 0;
      const data3 = result4.rows.map(row => {
        if (String(row.trans_flag) === '36') {
          sumSr += Number(row.total_amount);
        } else if (String(row.trans_flag) === '34') {
          sumSS += Number(row.total_amount);
        }
        return {
          doc_no: row.doc_no,
          doc_date: row.doc_date,
          trans_flag: row.trans_flag,
          total_amount: row.total_amount,
          remark: row.remark
        };
      });

      dataHead.sum_cheque = sumCheque.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      dataHead.sum_sr = sumSr.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      dataHead.sum_ss = sumSS.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      dataHead.sumsrss = (sumSr + sumSS).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      dataHead.sum_status = sumStatus.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      res.json({
        success: true,
        data_head: dataHead,
        data_1: data1,
        data_2: data2,
        data_3: data3
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('getCustomerCreditDetail error:', err);
    res.json({ success: false });
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
