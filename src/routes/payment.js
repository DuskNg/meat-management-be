// meat-management-be/src/routes/payment.js
const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment');
const { authenticateToken, requirePermission } = require('../middlewares/auth');

// Bảo vệ toàn bộ các API trả tiền nợ bằng token và quyền quản lý khách hàng
router.use(authenticateToken);
router.use(requirePermission('canManageCustomers'));

// Ghi nhận lượt thanh toán trả nợ của khách hàng
router.post('/', paymentController.createPayment);

// Lấy lịch sử trả nợ (có hỗ trợ lọc theo customerId)
router.get('/', paymentController.getPayments);

// Cập nhật lượt trả nợ theo ID
router.put('/:id', paymentController.updatePayment);

// Xóa lượt trả nợ theo ID
router.delete('/:id', paymentController.deletePayment);

module.exports = router;
