// meat-management-be/src/routes/store.js
const express = require('express');
const router = express.Router();
const { authenticateToken, requirePermission } = require('../middlewares/auth');
const storeController = require('../controllers/store');

// Tất cả các API quản lý cửa hàng yêu cầu đăng nhập và có quyền canManageStore
router.use(authenticateToken);
router.use(requirePermission('canManageStore'));

// 1. Quản lý Bàn ăn (Độc lập hoàn toàn)
router.get('/customers', storeController.getTables);
router.get('/customers/:id', storeController.getTableById);
router.post('/customers', storeController.createTable);
router.put('/customers/:id', storeController.updateTable);
router.delete('/customers/:id', storeController.deleteTable);
router.post('/tables/bulk', storeController.createTablesBulk);

// 2. Quản lý Thực đơn (Độc lập hoàn toàn)
router.get('/products', storeController.getProducts);
router.post('/products', storeController.createProduct);
router.put('/products/:id', storeController.updateProduct);
router.delete('/products/:id', storeController.deleteProduct);

// 3. Quản lý Hóa đơn gọi món (Độc lập hoàn toàn)
router.get('/transactions', storeController.getTransactions);
router.post('/transactions', storeController.createTransaction);
router.delete('/transactions/:id', storeController.deleteTransaction);
router.post('/scan-invoice', storeController.scanInvoice);
router.post('/voice-to-text', storeController.voiceToText);

// 4. Quản lý Thanh toán hóa đơn (Độc lập hoàn toàn)
router.get('/payments', storeController.getPayments);
router.post('/payments', storeController.createPayment);

// 5. Thống kê Doanh thu (Độc lập hoàn toàn)
router.get('/revenue/total', storeController.getStoreTotalRevenue);
router.get('/revenue/daily', storeController.getStoreDailyRevenue);

module.exports = router;
