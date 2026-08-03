// meat-management-be/src/routes/shop.js
const express = require('express');
const router = express.Router();
const { authenticateToken, requirePermission, resolveWorkspace } = require('../middlewares/auth');
const shopController = require('../controllers/shop');

// Tất cả các API quản lý cửa hàng tính giờ yêu cầu đăng nhập và có quyền canManageShop
router.use(authenticateToken);
router.use(resolveWorkspace); // Chuyển hướng userId sang workspace owner nếu là nhân viên
router.use(requirePermission('canManageShop'));

// 1. Quản lý Bàn chơi
router.get('/tables', shopController.getTables);
router.post('/tables', shopController.createTable);
router.put('/tables/:id', shopController.updateTable);
router.delete('/tables/:id', shopController.deleteTable);

// 2. Quản lý Phiên chơi
router.post('/sessions/start', shopController.startSession);
router.put('/sessions/:id/end', shopController.endSession);
router.put('/sessions/:id/extra', shopController.addExtra);
router.post('/sessions/:id/pay', shopController.paySession);

// 3. Thống kê doanh thu
router.get('/revenue/total', shopController.getTotalRevenue);
router.get('/revenue/daily', shopController.getDailyRevenue);

module.exports = router;
