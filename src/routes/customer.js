// meat-management-be/src/routes/customer.js
const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customer');
const { authenticateToken, requirePermission } = require('../middlewares/auth');

// Bảo vệ tất cả các tuyến đường quản lý khách hàng bằng middleware xác thực token và quyền
router.use(authenticateToken);
router.use(requirePermission('canManageCustomers'));

// Lấy danh sách toàn bộ khách hàng
router.get('/', customerController.getCustomers);

// Lấy chi tiết một khách hàng theo ID
router.get('/:id', customerController.getCustomerById);

// Tạo mới khách hàng
router.post('/', customerController.createCustomer);

// Cập nhật thông tin khách hàng theo ID
router.put('/:id', customerController.updateCustomer);

// Xóa mềm khách hàng theo ID
router.delete('/:id', customerController.deleteCustomer);

module.exports = router;
