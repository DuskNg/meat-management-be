// meat-management-be/src/routes/payment.js
const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment');
const { authenticateToken } = require('../middlewares/auth');

// Bảo vệ toàn bộ các API trả tiền nợ bằng token
router.use(authenticateToken);

// Ghi nhận lượt thanh toán trả nợ của khách hàng
router.post('/', paymentController.createPayment);

// Lấy lịch sử trả nợ (có hỗ trợ lọc theo customerId)
router.get('/', paymentController.getPayments);

module.exports = router;
