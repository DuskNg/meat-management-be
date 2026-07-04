// meat-management-be/src/routes/admin.js
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin');
const { authenticateToken, requireAdmin } = require('../middlewares/auth');

// Bảo vệ tất cả các tuyến đường quản lý của admin bằng middleware xác thực & quyền admin
router.use(authenticateToken);
router.use(requireAdmin);

// Lấy danh sách toàn bộ tài khoản
router.get('/users', adminController.getUsers);

// Cập nhật phân quyền của một tài khoản
router.put('/users/:id/permissions', adminController.updatePermissions);

// Xem logs hoạt động của một tài khoản theo ngày
router.get('/users/:id/logs', adminController.getUserLogs);

module.exports = router;
