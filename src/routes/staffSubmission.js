// meat-management-be/src/routes/staffSubmission.js
const express = require('express');
const router = express.Router();
const staffSubmissionController = require('../controllers/staffSubmission');
const { authenticateToken, resolveWorkspace } = require('../middlewares/auth');

// ─── 1. CÁC ROUTE CÔNG KHAI DÀNH CHO NHÂN VIÊN QUA LINK ZALO (KHÔNG CẦN LOGIN APP) ───
// Lấy thông tin cơ bản của link gửi qua token
router.get('/public/info/:token', staffSubmissionController.getPublicLinkInfo);

// Xác thực mã PIN (nếu link có cài PIN)
router.post('/public/verify-pin/:token', staffSubmissionController.verifyLinkPin);

// Nhân viên gửi hàng loạt ảnh hóa đơn / video
router.post('/public/submit/:token', staffSubmissionController.submitBatchFromStaff);

// Lịch sử gửi trong ngày của link (để nhân viên kiểm tra không gửi trùng)
router.get('/public/history/:token', staffSubmissionController.getPublicSubmissionHistory);

// ─── 2. CÁC ROUTE DÀNH CHO CHỦ BUÔN TRÊN APP (CẦN LOGIN & RESOLVE WORKSPACE) ───
// Lấy danh sách hóa đơn nhân viên nộp (lọc theo ngày, trạng thái)
router.get('/', authenticateToken, resolveWorkspace, staffSubmissionController.getStaffSubmissions);

// Lấy chi tiết 1 hóa đơn
router.get('/:id', authenticateToken, resolveWorkspace, staffSubmissionController.getStaffSubmissionDetail);

// Cập nhật/sửa thông tin AI bóc tách sai
router.put('/:id', authenticateToken, resolveWorkspace, staffSubmissionController.updateStaffSubmission);

// Phê duyệt và tự động tạo đơn nợ Transaction + TransactionInvoice
router.post('/:id/approve', authenticateToken, resolveWorkspace, staffSubmissionController.approveStaffSubmission);

// Xóa/bác bỏ hàng loạt hóa đơn
router.post('/batch-reject', authenticateToken, resolveWorkspace, staffSubmissionController.batchRejectStaffSubmissions);

// Bác bỏ/xóa hóa đơn
router.post('/:id/reject', authenticateToken, resolveWorkspace, staffSubmissionController.rejectStaffSubmission);

// Đồng bộ video/ảnh lên đám mây Cloudinary
router.post('/:id/sync-cloud', authenticateToken, resolveWorkspace, staffSubmissionController.syncCloudSubmission);

// Quét lại bằng AI
router.post('/:id/reparse', authenticateToken, resolveWorkspace, staffSubmissionController.reparseStaffSubmission);

// ─── 3. QUẢN LÝ LINK ZALO NHÂN VIÊN ───
// Lấy danh sách link Zalo nhân viên
router.get('/manage/links', authenticateToken, resolveWorkspace, staffSubmissionController.getSubmissionLinks);

// Tạo link Zalo nhân viên mới
router.post('/manage/links', authenticateToken, resolveWorkspace, staffSubmissionController.createSubmissionLink);

// Cập nhật link
router.put('/manage/links/:id', authenticateToken, resolveWorkspace, staffSubmissionController.updateSubmissionLink);

// Thu hồi và sinh token mới
router.post('/manage/links/:id/regenerate-token', authenticateToken, resolveWorkspace, staffSubmissionController.regenerateSubmissionToken);

// Xóa link
router.delete('/manage/links/:id', authenticateToken, resolveWorkspace, staffSubmissionController.deleteSubmissionLink);

module.exports = router;
