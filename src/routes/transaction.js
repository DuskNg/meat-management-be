// meat-management-be/src/routes/transaction.js
const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transaction');
const { authenticateToken, requirePermission, resolveWorkspace } = require('../middlewares/auth');

// Bảo vệ toàn bộ các API giao dịch mua bán bằng token và quyền quản lý khách hàng
router.use(authenticateToken);
router.use(resolveWorkspace); // Chuyển hướng userId sang workspace owner nếu là nhân viên
router.use(requirePermission('canManageCustomers'));

// Ghi nhận hóa đơn mua thịt nợ mới
router.post('/', transactionController.createTransaction);

// Lấy lịch sử giao dịch mua hàng ghi nợ (có hỗ trợ lọc theo customerId)
router.get('/', transactionController.getTransactions);

// Cập nhật đơn ghi nợ theo ID (thay thế toàn bộ items, ngày, ghi chú)
router.put('/:id', transactionController.updateTransaction);

// Xóa đơn ghi nợ theo ID
router.delete('/:id', transactionController.deleteTransaction);

// Nhận diện tích kê bán thịt từ hình ảnh qua Gemini API
router.post('/scan-ticket', transactionController.scanTicket);

// Nhận diện ghi nợ thịt từ ghi âm giọng nói qua Gemini API
router.post('/voice-to-text', transactionController.voiceToText);

// Phân tích câu thoại/transcript sang dữ liệu cấu trúc
router.post('/parse-transcript', transactionController.parseTranscript);

module.exports = router;
