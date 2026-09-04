// meat-management-be/src/routes/recurringDebt.js
const express = require('express');
const router = express.Router();
const recurringDebtController = require('../controllers/recurringDebt');
const { authenticateToken, requirePermission, resolveWorkspace } = require('../middlewares/auth');

// Bảo vệ các API đơn nợ cố định bằng token xác thực và phân quyền
router.use(authenticateToken);
router.use(resolveWorkspace);
router.use(requirePermission('canManageCustomers'));

// Lấy danh sách đơn nợ cố định hàng ngày
router.get('/', recurringDebtController.getRecurringDebts);

// Tạo mới mẫu đơn nợ cố định hàng ngày
router.post('/', recurringDebtController.createRecurringDebt);

// Cập nhật mẫu đơn nợ cố định
router.put('/:id', recurringDebtController.updateRecurringDebt);

// Xóa mẫu đơn nợ cố định
router.delete('/:id', recurringDebtController.deleteRecurringDebt);

module.exports = router;
