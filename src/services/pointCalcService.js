const pool = require('../config/db');

class PointCalcService {

  /**
   * Generate next point doc_no: PT-YYYYMMDD-XXXX
   */
  async generateDocNo(client) {
    const result = await client.query("SELECT nextval('mb_point_doc_seq') AS seq");
    const seq = String(result.rows[0].seq).padStart(6, '0');
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `PT-${today}-${seq}`;
  }

  /**
   * Get active point periods and build SQL WHERE clause for doc_date
   * Returns { clause, params } or null if no active period
   */
  async getActivePeriodFilter(client, paramOffset = 0) {
    const result = await client.query(
      `SELECT start_date, end_date FROM mb_point_period WHERE is_active = true ORDER BY start_date`
    );
    if (result.rows.length === 0) return null;

    const conditions = [];
    const params = [];
    for (let i = 0; i < result.rows.length; i++) {
      const p1 = paramOffset + (i * 2) + 1;
      const p2 = paramOffset + (i * 2) + 2;
      conditions.push(`(t.doc_date >= $${p1} AND t.doc_date <= $${p2})`);
      params.push(result.rows[i].start_date, result.rows[i].end_date);
    }

    return {
      clause: `AND (${conditions.join(' OR ')})`,
      params,
    };
  }

  /**
   * Get all point conditions from ic_size
   * Returns map: { code -> { code, name_1, amount_per_point, point_earned } }
   */
  async getPointConditions(client) {
    const result = await client.query(`
      SELECT code, name_1,
             COALESCE(NULLIF(width_length_height, '')::numeric, 0) AS amount_per_point,
             COALESCE(NULLIF(weight, '')::numeric, 0) AS point_earned
      FROM ic_size
      WHERE status = 0
      ORDER BY code
    `);
    const conditions = {};
    for (const row of result.rows) {
      conditions[row.code] = {
        code: row.code,
        name: row.name_1,
        amountPerPoint: parseFloat(row.amount_per_point) || 1000,
        pointEarned: parseFloat(row.point_earned) || 0,
      };
    }
    return conditions;
  }

  /**
   * Get point condition code for a specific item
   */
  async getItemCondition(client, itemCode) {
    const result = await client.query(
      `SELECT code FROM ic_size_use WHERE ic_code = $1 LIMIT 1`,
      [itemCode]
    );
    return result.rows.length > 0 ? result.rows[0].code : null;
  }

  /**
   * Batch check have_point for multiple item codes from ic_inventory_detail
   * Returns Set of item_codes that have have_point = 1
   */
  async getHavePointItems(client, itemCodes) {
    if (itemCodes.length === 0) return new Set();
    const placeholders = itemCodes.map((_, i) => `$${i + 1}`).join(',');
    const result = await client.query(
      `SELECT ic_code FROM ic_inventory_detail WHERE ic_code IN (${placeholders}) AND have_point = '1'`,
      itemCodes
    );
    return new Set(result.rows.map(r => r.ic_code));
  }

  /**
   * Calculate points for a single sale document (trans_flag=44)
   */
  async calcSaleDoc(client, doc) {
    // Get detail items
    const detailRes = await client.query(
      `SELECT barcode, item_code, item_name, unit_code, qty, price, sum_amount
       FROM ic_trans_detail 
       WHERE doc_no = $1 AND trans_flag = 44`,
      [doc.doc_no]
    );

    if (detailRes.rows.length === 0) return null;

    // Filter: only items with have_point = 1 in ic_inventory_detail
    const allItemCodes = detailRes.rows.map(r => r.item_code);
    const havePointSet = await this.getHavePointItems(client, [...new Set(allItemCodes)]);
    const eligibleItems = detailRes.rows.filter(r => havePointSet.has(r.item_code));

    if (eligibleItems.length === 0) return null;

    const conditions = await this.getPointConditions(client);

    // Group items by their point condition
    // conditionCode -> { totalAmount, items[] }
    const conditionGroups = {};
    const noConditionItems = [];

    for (const item of eligibleItems) {
      const condCode = await this.getItemCondition(client, item.item_code);

      if (condCode && conditions[condCode]) {
        if (!conditionGroups[condCode]) {
          conditionGroups[condCode] = { totalAmount: 0, items: [] };
        }
        const amount = parseFloat(item.sum_amount) || 0;
        conditionGroups[condCode].totalAmount += amount;
        conditionGroups[condCode].items.push({ ...item, condCode, amount });
      } else {
        noConditionItems.push({ ...item, condCode: null, amount: parseFloat(item.sum_amount) || 0 });
      }
    }

    // Calculate points per condition group
    let totalGetPoint = 0;
    const pointDetails = [];

    for (const [condCode, group] of Object.entries(conditionGroups)) {
      const cond = conditions[condCode];
      // Floor division: how many times the total reaches the threshold
      const earnedPoint = Math.floor(group.totalAmount / cond.amountPerPoint) * cond.pointEarned;
      totalGetPoint += earnedPoint;

      // Distribute points proportionally to each item
      for (const item of group.items) {
        const itemPoint = group.totalAmount > 0
          ? Math.round((item.amount / group.totalAmount) * earnedPoint * 100) / 100
          : 0;

        pointDetails.push({
          doc_date: doc.doc_date,
          cust_code: doc.cust_code,
          barcode: item.barcode,
          item_code: item.item_code,
          item_name: item.item_name,
          unit_code: item.unit_code,
          qty: item.qty,
          price: item.price,
          sale_amount: item.amount,
          return_amount: 0,
          total_amount: item.amount,
          get_point: itemPoint,
          remark: condCode,
        });
      }
    }

    // Items without conditions - still record them but 0 points
    for (const item of noConditionItems) {
      pointDetails.push({
        doc_date: doc.doc_date,
        cust_code: doc.cust_code,
        barcode: item.barcode,
        item_code: item.item_code,
        item_name: item.item_name,
        unit_code: item.unit_code,
        qty: item.qty,
        price: item.price,
        sale_amount: item.amount,
        return_amount: 0,
        total_amount: item.amount,
        get_point: 0,
        remark: null,
      });
    }

    // Adjust rounding so detail points sum to total
    const detailSum = pointDetails.reduce((s, d) => s + d.get_point, 0);
    if (pointDetails.length > 0 && detailSum !== totalGetPoint) {
      pointDetails[0].get_point += (totalGetPoint - detailSum);
    }

    return {
      doc_date: doc.doc_date,
      doc_time: doc.doc_time,
      doc_no_sale: doc.doc_no,
      doc_no_return: null,
      cust_code: doc.cust_code,
      sum_sale_amount: eligibleItems.reduce((s, r) => s + (parseFloat(r.sum_amount) || 0), 0),
      sum_return_amount: 0,
      get_point: totalGetPoint,
      use_point: 0,
      remark: 'คำนวณจากบิลขาย',
      details: pointDetails,
    };
  }

  /**
   * Calculate points for a return document (trans_flag=48)
   * Returns negative points (deduction)
   */
  async calcReturnDoc(client, doc) {
    const detailRes = await client.query(
      `SELECT barcode, item_code, item_name, unit_code, qty, price, sum_amount
       FROM ic_trans_detail 
       WHERE doc_no = $1 AND trans_flag = 48`,
      [doc.doc_no]
    );

    if (detailRes.rows.length === 0) return null;

    // Filter: only items with have_point = 1 in ic_inventory_detail
    const allItemCodes = detailRes.rows.map(r => r.item_code);
    const havePointSet = await this.getHavePointItems(client, [...new Set(allItemCodes)]);
    const eligibleItems = detailRes.rows.filter(r => havePointSet.has(r.item_code));

    if (eligibleItems.length === 0) return null;

    // For returns: we need to figure out points to deduct
    // Look at the original sale's point calculation
    // Find the original sale point trans
    let originalGetPoint = 0;
    let originalSaleAmount = 0;

    if (doc.doc_ref) {
      const origRes = await client.query(
        `SELECT sum_sale_amount, get_point FROM mb_point_trans WHERE doc_no_sale = $1 LIMIT 1`,
        [doc.doc_ref]
      );
      if (origRes.rows.length > 0) {
        originalSaleAmount = parseFloat(origRes.rows[0].sum_sale_amount) || 0;
        originalGetPoint = parseFloat(origRes.rows[0].get_point) || 0;
      }
    }

    const returnTotalAmount = eligibleItems.reduce((s, r) => s + (parseFloat(r.sum_amount) || 0), 0);

    // Proportional point deduction based on return amount vs original sale amount
    let deductPoint = 0;
    if (originalSaleAmount > 0 && originalGetPoint > 0) {
      deductPoint = Math.floor((returnTotalAmount / originalSaleAmount) * originalGetPoint);
    } else {
      // If no original found, recalculate based on conditions
      const conditions = await this.getPointConditions(client);
      const conditionGroups = {};

      for (const item of eligibleItems) {
        const condCode = await this.getItemCondition(client, item.item_code);
        if (condCode && conditions[condCode]) {
          if (!conditionGroups[condCode]) conditionGroups[condCode] = { totalAmount: 0 };
          conditionGroups[condCode].totalAmount += (parseFloat(item.sum_amount) || 0);
        }
      }

      for (const [condCode, group] of Object.entries(conditionGroups)) {
        const cond = conditions[condCode];
        deductPoint += Math.floor(group.totalAmount / cond.amountPerPoint) * cond.pointEarned;
      }
    }

    const pointDetails = eligibleItems.map(item => ({
      doc_date: doc.doc_date,
      cust_code: doc.cust_code,
      barcode: item.barcode,
      item_code: item.item_code,
      item_name: item.item_name,
      unit_code: item.unit_code,
      qty: item.qty,
      price: item.price,
      sale_amount: 0,
      return_amount: parseFloat(item.sum_amount) || 0,
      total_amount: -(parseFloat(item.sum_amount) || 0),
      get_point: 0,
      remark: 'คืนสินค้า',
    }));

    return {
      doc_date: doc.doc_date,
      doc_time: doc.doc_time,
      doc_no_sale: null,
      doc_no_return: doc.doc_no,
      cust_code: doc.cust_code,
      sum_sale_amount: 0,
      sum_return_amount: returnTotalAmount,
      get_point: -deductPoint,  // negative for returns
      use_point: 0,
      remark: `คืนสินค้า อ้างอิง ${doc.doc_ref || '-'}`,
      details: pointDetails,
    };
  }

  /**
   * Save point transaction
   */
  async savePointTrans(client, docNo, trans) {
    const sumTotal = trans.sum_sale_amount - trans.sum_return_amount;
    const now = new Date();

    await client.query(
      `INSERT INTO mb_point_trans 
       (doc_date, doc_time, doc_no, doc_no_sale, doc_no_return, cust_code,
        sum_sale_amount, sum_return_amount, sum_total_amount, 
        get_point, use_point, remark, lastedit_datetime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (doc_no) DO UPDATE SET
        sum_sale_amount = EXCLUDED.sum_sale_amount,
        sum_return_amount = EXCLUDED.sum_return_amount,
        sum_total_amount = EXCLUDED.sum_total_amount,
        get_point = EXCLUDED.get_point,
        use_point = EXCLUDED.use_point,
        remark = EXCLUDED.remark,
        lastedit_datetime = EXCLUDED.lastedit_datetime`,
      [trans.doc_date, trans.doc_time, docNo, trans.doc_no_sale, trans.doc_no_return,
       trans.cust_code, trans.sum_sale_amount, trans.sum_return_amount, sumTotal,
       trans.get_point, trans.use_point, trans.remark, now]
    );

    // Delete old details then insert new
    await client.query(`DELETE FROM mb_point_trans_detail WHERE doc_no = $1`, [docNo]);

    for (const d of trans.details) {
      await client.query(
        `INSERT INTO mb_point_trans_detail
         (doc_date, doc_no, cust_code, barcode, item_code, item_name, unit_code,
          qty, price, sale_amount, return_amount, total_amount, get_point, remark, lastedit_datetime)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [d.doc_date, docNo, d.cust_code, d.barcode, d.item_code, d.item_name, d.unit_code,
         d.qty, d.price, d.sale_amount, d.return_amount, d.total_amount, d.get_point, d.remark, now]
      );
    }
  }

  /**
   * Update customer point balance
   */
  async updateCustomerPoints(client, custCode) {
    // Sum all get_point and use_point from mb_point_trans
    const result = await client.query(
      `SELECT 
         COALESCE(SUM(CASE WHEN get_point > 0 THEN get_point ELSE 0 END), 0) AS total_get,
         COALESCE(SUM(CASE WHEN get_point < 0 THEN ABS(get_point) ELSE 0 END), 0) AS total_return_deduct,
         COALESCE(SUM(use_point), 0) AS total_use
       FROM mb_point_trans 
       WHERE cust_code = $1`,
      [custCode]
    );

    const { total_get, total_return_deduct, total_use } = result.rows[0];
    const rewardPoint = parseFloat(total_get) - parseFloat(total_return_deduct);
    const pointBalance = rewardPoint - parseFloat(total_use);

    await client.query(
      `UPDATE ar_customer SET point_balance = $1, reward_point = $2 WHERE code = $3`,
      [pointBalance, rewardPoint, custCode]
    );

    return { pointBalance, rewardPoint };
  }

  /**
   * Main: Process all unprocessed/modified documents
   */
  async processAllDocs() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ตรวจสอบช่วงวันที่ที่ active — ถ้าไม่มี ไม่คำนวณ
      const periodFilter = await this.getActivePeriodFilter(client);
      if (!periodFilter) {
        await client.query('COMMIT');
        console.log('[PointCalc] No active point period configured, skipping');
        return { success: true, processedCount: 0, message: 'ไม่มีช่วงวันที่ให้แต้มที่เปิดใช้งาน' };
      }

      let processedCount = 0;

      // --- Process Sale Documents (trans_flag = 44) ---
      const saleDocs = await client.query(
        `SELECT t.doc_date, t.doc_time, t.doc_no, t.doc_ref, t.doc_ref_date,
               t.cust_code, t.lastedit_datetime
        FROM ic_trans t
        WHERE t.trans_flag = 44 AND t.last_status = 0
          AND t.cust_code IS NOT NULL AND t.cust_code != ''
          ${periodFilter.clause}
          AND (
            NOT EXISTS (
              SELECT 1 FROM mb_point_calc_log l
              WHERE l.doc_no = t.doc_no AND l.trans_flag = 44
            )
            OR t.lastedit_datetime > (
              SELECT l.lastedit_datetime FROM mb_point_calc_log l
              WHERE l.doc_no = t.doc_no AND l.trans_flag = 44
            )
          )`,
        periodFilter.params
      );

      console.log(`[PointCalc] Found ${saleDocs.rows.length} sale docs to process`);

      for (const doc of saleDocs.rows) {
        const trans = await this.calcSaleDoc(client, doc);
        if (trans) {
          const existing = await client.query(
            `SELECT doc_no FROM mb_point_trans WHERE doc_no_sale = $1`,
            [doc.doc_no]
          );

          const pointDocNo = existing.rows.length > 0
            ? existing.rows[0].doc_no
            : await this.generateDocNo(client);

          await this.savePointTrans(client, pointDocNo, trans);
          await this.updateCustomerPoints(client, doc.cust_code);

          await client.query(
            `INSERT INTO mb_point_calc_log (doc_no, trans_flag, lastedit_datetime, calc_datetime)
             VALUES ($1, 44, $2, NOW())
             ON CONFLICT (doc_no, trans_flag) DO UPDATE SET
               lastedit_datetime = EXCLUDED.lastedit_datetime,
               calc_datetime = NOW()`,
            [doc.doc_no, doc.lastedit_datetime]
          );

          processedCount++;
        }
      }

      // --- Process Return Documents (trans_flag = 48) ---
      const returnDocs = await client.query(
        `SELECT t.doc_date, t.doc_time, t.doc_no, t.doc_ref, t.doc_ref_date,
               t.cust_code, t.lastedit_datetime
        FROM ic_trans t
        WHERE t.trans_flag = 48 AND t.last_status = 0
          AND t.cust_code IS NOT NULL AND t.cust_code != ''
          ${periodFilter.clause}
          AND (
            NOT EXISTS (
              SELECT 1 FROM mb_point_calc_log l
              WHERE l.doc_no = t.doc_no AND l.trans_flag = 48
            )
            OR t.lastedit_datetime > (
              SELECT l.lastedit_datetime FROM mb_point_calc_log l
              WHERE l.doc_no = t.doc_no AND l.trans_flag = 48
            )
          )`,
        periodFilter.params
      );

      console.log(`[PointCalc] Found ${returnDocs.rows.length} return docs to process`);

      for (const doc of returnDocs.rows) {
        const trans = await this.calcReturnDoc(client, doc);
        if (trans) {
          const existing = await client.query(
            `SELECT doc_no FROM mb_point_trans WHERE doc_no_return = $1`,
            [doc.doc_no]
          );

          const pointDocNo = existing.rows.length > 0
            ? existing.rows[0].doc_no
            : await this.generateDocNo(client);

          await this.savePointTrans(client, pointDocNo, trans);
          await this.updateCustomerPoints(client, doc.cust_code);

          await client.query(
            `INSERT INTO mb_point_calc_log (doc_no, trans_flag, lastedit_datetime, calc_datetime)
             VALUES ($1, 48, $2, NOW())
             ON CONFLICT (doc_no, trans_flag) DO UPDATE SET
               lastedit_datetime = EXCLUDED.lastedit_datetime,
               calc_datetime = NOW()`,
            [doc.doc_no, doc.lastedit_datetime]
          );

          processedCount++;
        }
      }

      await client.query('COMMIT');
      console.log(`[PointCalc] Processed ${processedCount} documents`);
      return { success: true, processedCount };

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[PointCalc] Error:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Recalculate all points for a specific customer
   */
  async recalcCustomer(custCode) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ตรวจสอบช่วงวันที่ active
      const periodFilter = await this.getActivePeriodFilter(client, 1); // offset=1 เพราะ $1 = custCode
      if (!periodFilter) {
        await client.query('COMMIT');
        return { pointBalance: 0, rewardPoint: 0, message: 'ไม่มีช่วงวันที่ให้แต้มที่เปิดใช้งาน' };
      }

      // Delete existing point trans for this customer (ยกเว้น use_point ที่เป็นการใช้แต้ม)
      await client.query(`DELETE FROM mb_point_trans_detail WHERE cust_code = $1`, [custCode]);
      await client.query(`DELETE FROM mb_point_trans WHERE cust_code = $1 AND use_point = 0`, [custCode]);
      await client.query(
        `DELETE FROM mb_point_calc_log WHERE doc_no IN (
           SELECT doc_no FROM ic_trans WHERE cust_code = $1 AND trans_flag IN (44, 48) AND last_status = 0
         )`,
        [custCode]
      );

      // Re-process sale docs — filter ตาม period
      const saleDocs = await client.query(
        `SELECT t.doc_date, t.doc_time, t.doc_no, t.doc_ref, t.doc_ref_date, t.cust_code, t.lastedit_datetime
         FROM ic_trans t WHERE t.trans_flag = 44 AND t.last_status = 0 AND t.cust_code = $1
         ${periodFilter.clause}
         ORDER BY t.doc_date, t.doc_time`,
        [custCode, ...periodFilter.params]
      );

      for (const doc of saleDocs.rows) {
        const trans = await this.calcSaleDoc(client, doc);
        if (trans) {
          const docNo = await this.generateDocNo(client);
          await this.savePointTrans(client, docNo, trans);
          await client.query(
            `INSERT INTO mb_point_calc_log (doc_no, trans_flag, lastedit_datetime, calc_datetime)
             VALUES ($1, 44, $2, NOW())
             ON CONFLICT (doc_no, trans_flag) DO UPDATE SET
               lastedit_datetime = EXCLUDED.lastedit_datetime, calc_datetime = NOW()`,
            [doc.doc_no, doc.lastedit_datetime]
          );
        }
      }

      // Re-process return docs — filter ตาม period
      const returnDocs = await client.query(
        `SELECT t.doc_date, t.doc_time, t.doc_no, t.doc_ref, t.doc_ref_date, t.cust_code, t.lastedit_datetime
         FROM ic_trans t WHERE t.trans_flag = 48 AND t.last_status = 0 AND t.cust_code = $1
         ${periodFilter.clause}
         ORDER BY t.doc_date, t.doc_time`,
        [custCode, ...periodFilter.params]
      );

      for (const doc of returnDocs.rows) {
        const trans = await this.calcReturnDoc(client, doc);
        if (trans) {
          const docNo = await this.generateDocNo(client);
          await this.savePointTrans(client, docNo, trans);
          await client.query(
            `INSERT INTO mb_point_calc_log (doc_no, trans_flag, lastedit_datetime, calc_datetime)
             VALUES ($1, 48, $2, NOW())
             ON CONFLICT (doc_no, trans_flag) DO UPDATE SET
               lastedit_datetime = EXCLUDED.lastedit_datetime, calc_datetime = NOW()`,
            [doc.doc_no, doc.lastedit_datetime]
          );
        }
      }

      const result = await this.updateCustomerPoints(client, custCode);
      await client.query('COMMIT');
      return result;

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = new PointCalcService();
