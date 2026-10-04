// meat-management-be/src/routes/periodicReminder.js
const express = require('express');
const router = express.Router();
const periodicReminderController = require('../controllers/periodicReminder');
const { authenticateToken, requirePermission, resolveWorkspace } = require('../middlewares/auth');

// Bảo vệ toàn bộ các API cấu hình nhắc nợ bằng token và quyền quản lý khách hàng
router.use(authenticateToken);
router.use(resolveWorkspace);
router.use(requirePermission('canManageCustomers'));

// 1. Lấy danh sách cấu hình nhắc nợ
router.get('/', periodicReminderController.getPeriodicReminders);

// 2. Thêm mới hoặc cập nhật cấu hình nhắc nợ cho một khách hàng
router.post('/', periodicReminderController.upsertPeriodicReminder);

// 3. Sửa cấu hình nhắc nợ theo ID
router.put('/:id', periodicReminderController.updatePeriodicReminder);

// 4. Xóa cấu hình nhắc nợ theo ID
router.delete('/:id', periodicReminderController.deletePeriodicReminder);

module.exports = router;
