// meat-management-be/src/routes/inventory.js
const express = require('express');
const router = express.Router();
const { authenticateToken, requirePermission, resolveWorkspace } = require('../middlewares/auth');
const inventoryController = require('../controllers/inventory');

// Yêu cầu đăng nhập và có quyền canManageInventory cho tất cả các API quản lý kho
router.use(authenticateToken);
router.use(resolveWorkspace); // Chuyển hướng userId sang workspace owner nếu là nhân viên
router.use(requirePermission('canManageInventory'));

// Quản lý sản phẩm trong kho
router.get('/products', inventoryController.getInventoryProducts);
router.post('/products', inventoryController.createInventoryProduct);
router.put('/products/:id', inventoryController.updateInventoryProduct);
router.delete('/products/:id', inventoryController.deleteInventoryProduct);

// Nghiệp vụ Nhập / Xuất / Điều chỉnh kiểm kê và Lịch sử thẻ kho
router.post('/products/:id/adjust', inventoryController.adjustInventoryStock);
router.get('/products/:id/logs', inventoryController.getInventoryLogs);

module.exports = router;
