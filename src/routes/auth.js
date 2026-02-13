const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const { authMiddleware } = require("../middleware/auth");

const router = express.Router();

// POST /api/auth/login
// ลอง ar_customer (member) ก่อน → ถ้าไม่เจอ ลอง erp_user (staff)
router.post("/login", async (req, res) => {
  try {
    const { username, password, login_mode } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "กรุณากรอก username และ password" });
    }

    // login_mode: "member" = ค้นหาเฉพาะ ar_customer, "staff" = ค้นหาเฉพาะ erp_user
    // ถ้าไม่ระบุ = ลองทั้ง 2 (ค้นหา ar_customer ก่อน)

    // 1. ลองหาจาก ar_customer (สมาชิก)
    if (login_mode !== "staff") {
      const custResult = await pool.query("SELECT code, country, name_1, point_balance, reward_point FROM ar_customer WHERE code = $1", [username]);

      if (custResult.rows.length > 0) {
        const cust = custResult.rows[0];
        if (cust.country !== password) {
          return res.status(401).json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
        }

        const token = jwt.sign({ username: cust.code, role: "member", cust_code: cust.code, display_name: cust.name_1 }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "24h" });

        return res.json({
          token,
          user: {
            username: cust.code,
            role: "member",
            cust_code: cust.code,
            display_name: cust.name_1,
          },
        });
      }
    }

    // 2. ลองหาจาก erp_user (พนักงาน)
    if (login_mode !== "member") {
      const staffResult = await pool.query("SELECT code, password, name_1 FROM erp_user WHERE upper(code) = $1", [username.toUpperCase()]);

      if (staffResult.rows.length > 0) {
        const staff = staffResult.rows[0];
        if (staff.password !== password) {
          return res.status(401).json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
        }

        const token = jwt.sign({ username: staff.code, role: "staff", display_name: staff.name_1 }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "24h" });

        return res.json({
          token,
          user: {
            username: staff.code,
            role: "staff",
            display_name: staff.name_1,
          },
        });
      }
    }

    // ไม่เจอ
    return res.status(401).json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "เกิดข้อผิดพลาด" });
  }
});

// GET /api/auth/me
router.get("/me", authMiddleware, async (req, res) => {
  try {
    if (req.user.role === "member") {
      const custRes = await pool.query("SELECT code, name_1, point_balance, reward_point FROM ar_customer WHERE code = $1", [req.user.cust_code]);
      if (custRes.rows.length === 0) {
        return res.status(404).json({ error: "ไม่พบข้อมูลผู้ใช้" });
      }
      const cust = custRes.rows[0];
      return res.json({
        user: {
          username: cust.code,
          role: "member",
          cust_code: cust.code,
          display_name: cust.name_1,
          customer: {
            code: cust.code,
            name_1: cust.name_1,
            point_balance: cust.point_balance,
            reward_point: cust.reward_point,
          },
        },
      });
    }

    if (req.user.role === "staff") {
      const staffRes = await pool.query("SELECT code, name_1 FROM erp_user WHERE code = $1", [req.user.username]);
      if (staffRes.rows.length === 0) {
        return res.status(404).json({ error: "ไม่พบข้อมูลผู้ใช้" });
      }
      const staff = staffRes.rows[0];
      return res.json({
        user: {
          username: staff.code,
          role: "staff",
          display_name: staff.name_1,
        },
      });
    }

    return res.status(400).json({ error: "ไม่ทราบ role ผู้ใช้" });
  } catch (err) {
    console.error("Auth me error:", err);
    res.status(500).json({ error: "เกิดข้อผิดพลาด" });
  }
});

module.exports = router;
