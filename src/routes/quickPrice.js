// meat-management-be/src/routes/quickPrice.js
const express = require('express');
const router = express.Router();
const quickPriceController = require('../controllers/quickPrice');
const { authenticateToken, resolveWorkspace } = require('../middlewares/auth');

// ─── 1. CÁC ROUTE PUBLIC CHO ANH CHỦ TRUY CẬP QUA LINK ZALO (KHÔNG CẦN LOGIN APP) ───
// Lấy thông tin cơ bản của link, danh sách khách hàng và danh mục thịt
router.get('/public/info/:token', quickPriceController.getPublicLinkInfo);

// Xác thực mã PIN (nếu link có cài đặt mã PIN)
router.post('/public/verify-pin/:token', quickPriceController.verifyLinkPin);

// Lấy danh sách giá bán riêng hiện có của một khách hàng
router.get('/public/customer-prices/:token/:customerId', quickPriceController.getCustomerPrices);

// Áp dụng bảng giá mới và tự động tính lại đơn nợ từ ngày áp dụng về sau
router.post('/public/apply/:token', quickPriceController.applyQuickPriceUpdate);

// ─── 2. CÁC ROUTE QUẢN LÝ LINK TRÊN APP CHÍNH (CẦN LOGIN & RESOLVE WORKSPACE) ───
// Lấy link Zalo cập nhật giá của chủ buôn (tự động tạo mới nếu chưa có)
router.get('/manage/link', authenticateToken, resolveWorkspace, quickPriceController.getOwnerQuickPriceLink);

// Thu hồi và sinh mã link mới
router.post('/manage/regenerate', authenticateToken, resolveWorkspace, quickPriceController.regenerateOwnerQuickPriceLink);

// Cập nhật cấu hình link (tên, mã PIN)
router.put('/manage/link/:id', authenticateToken, resolveWorkspace, quickPriceController.updateOwnerQuickPriceLink);

module.exports = router;
