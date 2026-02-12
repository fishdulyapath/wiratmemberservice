require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const authRoutes = require('./routes/auth');
const customerRoutes = require('./routes/customers');
const transactionRoutes = require('./routes/transactions');
const pointRoutes = require('./routes/points');
const pointConfigRoutes = require('./routes/pointConfig');
const pointCalcService = require('./services/pointCalcService');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/points', pointRoutes);
app.use('/api/point-config', pointConfigRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// --- Timer: Auto point calculation ---
const cronExpression = process.env.POINT_CALC_CRON || '*/30 * * * *';
let isProcessing = false;

cron.schedule(cronExpression, async () => {
  if (isProcessing) {
    console.log('[Cron] Previous point calculation still running, skipping...');
    return;
  }
  isProcessing = true;
  console.log(`[Cron] Starting point calculation at ${new Date().toISOString()}`);
  try {
    const result = await pointCalcService.processAllDocs();
    console.log(`[Cron] Completed: ${result.processedCount} docs processed`);
  } catch (err) {
    console.error('[Cron] Point calculation failed:', err);
  } finally {
    isProcessing = false;
  }
});

console.log(`[Cron] Point calculation scheduled: ${cronExpression}`);

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
