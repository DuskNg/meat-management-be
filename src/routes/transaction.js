// meat-management-be/src/routes/transaction.js
const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transaction');
const { authenticateToken } = require('../middlewares/auth');

// Bảo vệ toàn bộ các API giao dịch mua bán bằng token
router.use(authenticateToken);

// Ghi nhận hóa đơn mua thịt nợ mới
router.post('/', transactionController.createTransaction);

// Lấy lịch sử giao dịch mua hàng ghi nợ (có hỗ trợ lọc theo customerId)
router.get('/', transactionController.getTransactions);

module.exports = router;
