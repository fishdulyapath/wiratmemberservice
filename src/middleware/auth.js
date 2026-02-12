const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token ไม่ถูกต้องหรือหมดอายุ' });
  }
}

function staffOnly(req, res, next) {
  if (req.user.role !== 'staff') {
    return res.status(403).json({ error: 'เฉพาะพนักงานเท่านั้น' });
  }
  next();
}

function memberOnly(req, res, next) {
  if (req.user.role !== 'member') {
    return res.status(403).json({ error: 'เฉพาะสมาชิกเท่านั้น' });
  }
  next();
}

module.exports = { authMiddleware, staffOnly, memberOnly };
