// meat-management-be/src/routes/bankTransaction.js
const express = require('express');
const router = express.Router();
const bankTransactionController = require('../controllers/bankTransaction');
const { authenticateToken, resolveWorkspace } = require('../middlewares/auth');

// ─── 1. WEBHOOK TỪ SEPAY (CÔNG KHAI, KHÔNG CẦN BEARER TOKEN APP) ───
// Cấu hình URL này trên bảng điều khiển SePay:
// https://<tên-miền-của-bạn>/api/v1/bank-transactions/webhook
router.post('/webhook', bankTransactionController.handleSepayWebhook);

// ─── 2. CÁC API DÀNH CHO CHỦ BUÔN TRÊN APP (YÊU CẦU ĐĂNG NHẬP) ───
// Lấy danh sách giao dịch ngân hàng
router.get('/', authenticateToken, resolveWorkspace, bankTransactionController.getBankTransactions);

// Gán giao dịch cho một khách hàng cụ thể (tạo phiếu thu nợ)
router.post('/:id/assign-customer', authenticateToken, resolveWorkspace, bankTransactionController.assignCustomerAndDeductDebt);

// Đánh dấu bỏ qua giao dịch
router.put('/:id/ignore', authenticateToken, resolveWorkspace, bankTransactionController.ignoreBankTransaction);

// Khôi phục giao dịch về chưa xử lý (và xóa phiếu thu nợ tương ứng nếu có)
router.put('/:id/restore', authenticateToken, resolveWorkspace, bankTransactionController.restoreBankTransaction);

module.exports = router;
