// meat-management-be/src/routes/portal.js
const express = require('express');
const router = express.Router();
const portalController = require('../controllers/portal');
const { authenticateToken, resolveWorkspace } = require('../middlewares/auth');

// ─── 1. CÁC TUYẾN ĐƯỜNG CÔNG KHAI (KHÔNG CẦN TÀI KHOẢN APP) ───
// Lấy thông tin cơ bản của nhóm Zalo qua token
router.get('/info/:token', portalController.getPublicPortalInfo);

// Xác thực mã PIN nhóm Zalo (nếu nhóm có đặt PIN)
router.post('/verify-pin/:token', portalController.verifyPortalPin);

// Lấy số liệu công nợ, đơn hàng, bảng giá thịt an toàn
router.get('/data/:token', portalController.getPublicPortalData);

// Lấy chi tiết công nợ từng cửa hàng theo tháng và tổng nợ toàn bộ
router.get('/branches-debt/:token', portalController.getBranchesDebtByMonth);

// Gửi phản hồi / khiếu nại / báo lệch từ cổng portal
router.post('/feedback/:token', portalController.submitPortalFeedback);

// ─── 2. CÁC TUYẾN ĐƯỜNG QUẢN LÝ DÀNH CHO CHỦ BUÔN TRÊN APP ───
// Lấy danh sách link ghim Zalo
router.get('/manage/links', authenticateToken, resolveWorkspace, portalController.getPortalLinks);

// Tạo link ghim Zalo mới (cho 1 hoặc chuỗi nhiều quán / NCC)
router.post('/manage/links', authenticateToken, resolveWorkspace, portalController.createPortalLink);

// Cập nhật thông tin link ghim Zalo
router.put('/manage/links/:id', authenticateToken, resolveWorkspace, portalController.updatePortalLink);

// Thu hồi link cũ và sinh link mới ngay lập tức
router.post('/manage/links/:id/regenerate-token', authenticateToken, resolveWorkspace, portalController.regeneratePortalToken);

// Xóa link ghim Zalo
router.delete('/manage/links/:id', authenticateToken, resolveWorkspace, portalController.deletePortalLink);

// Xem danh sách phản hồi từ các nhóm Zalo gửi về
router.get('/manage/feedbacks', authenticateToken, resolveWorkspace, portalController.getPortalFeedbacks);

// Xử lý / đóng phản hồi
router.put('/manage/feedbacks/:id', authenticateToken, resolveWorkspace, portalController.resolvePortalFeedback);

module.exports = router;
