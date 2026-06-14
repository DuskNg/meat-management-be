// meat-management-be/src/routes/customer.js
const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customer');
const { authenticateToken } = require('../middlewares/auth');

// Bảo vệ tất cả các tuyến đường quản lý khách hàng bằng middleware xác thực token
router.use(authenticateToken);

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
