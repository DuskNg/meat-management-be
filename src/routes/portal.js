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

// Đơn báo lấy hàng từ portal (hôm nay / ngày mai)
router.post('/delivery-request/:token', portalController.submitDeliveryRequest);
router.get('/delivery-request/:token', portalController.getPortalDeliveryRequests);
router.delete('/delivery-request/:token/:id', portalController.cancelDeliveryRequest);

// Đồng bộ video/ảnh hóa đơn lên Cloudinary qua portal (không cần auth Bearer, xác thực qua portal token + session)
router.post('/sync-invoice/:token/:invoiceId', portalController.syncInvoiceViaPortal);

// Chủ buôn công bố số liệu trực tiếp ngay trên portal
router.post('/publish/:token', portalController.publishByToken);

// ─── THAO TÁC CÔNG NỢ TRỰC TIẾP TRÊN PORTAL (BẢO VỆ BẰNG MÃ PIN CHỦ BUÔN) ───
// 1. Xác thực mã PIN
router.post('/debt-action/verify-pin/:token', portalController.verifyPortalDebtActionPin);
// 2. Lấy dữ liệu danh mục hàng, khách hàng, giá riêng
router.get('/debt-action/bootstrap/:token', portalController.getPortalDebtActionBootstrap);
// 3. Thu công nợ
router.post('/debt-action/collect-debt/:token', portalController.submitPortalCollectDebt);
// 4. Ghi nợ mới
router.post('/debt-action/create-debt/:token', portalController.submitPortalCreateDebt);
// 5. Cập nhật đơn nợ
router.put('/debt-action/update-debt/:token/:transactionId', portalController.submitPortalUpdateDebt);
// 6. Xóa đơn nợ
router.delete('/debt-action/delete-debt/:token/:transactionId', portalController.submitPortalDeleteDebt);
// 7. Xóa khoản thanh toán
router.delete('/debt-action/delete-payment/:token/:paymentId', portalController.submitPortalDeletePayment);

// ─── CỔNG TRA CỨU PHIẾU LƯƠNG & CHẤM CÔNG NHÂN VIÊN QUA ZALO ───
// Lấy thông tin cơ bản & kiểm tra yêu cầu mã PIN
router.get('/employee-salary/info/:token', portalController.getEmployeeSalaryPortalInfo);

// Lấy toàn bộ số liệu lương, chấm công, tạm ứng theo tháng
router.get('/employee-salary/data/:token', portalController.getEmployeeSalaryPortalData);

// ─── CỔNG THÔNG TIN NHÂN SỰ CHUNG & NỘI QUY CỬA HÀNG ───
router.get('/staff/info/:token', portalController.getStaffPortalInfo);
router.get('/staff/salary/:token', portalController.getStaffPortalSalaryData);

// ─── 2. CÁC TUYẾN ĐƯỜNG QUẢN LÝ DÀNH CHO CHỦ BUÔN TRÊN APP ───
// Lấy danh sách link ghim Zalo
router.get('/manage/links', authenticateToken, resolveWorkspace, portalController.getPortalLinks);

// Công bố số liệu mới cho TOÀN BỘ các link nhóm Zalo
router.post('/manage/links/publish-all', authenticateToken, resolveWorkspace, portalController.publishAllPortalData);

// Công bố số liệu mới cho 1 link nhóm Zalo cụ thể
router.post('/manage/links/:id/publish', authenticateToken, resolveWorkspace, portalController.publishPortalData);

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

// Quản lý đơn báo hàng & Chốt đơn từ nhà hàng (Hôm nay / Ngày mai)
router.get('/manage/delivery-requests', authenticateToken, resolveWorkspace, portalController.getAdminDeliveryRequests);
router.put('/manage/delivery-requests/:id/confirm', authenticateToken, resolveWorkspace, portalController.confirmDeliveryRequest);
router.put('/manage/delivery-requests/bulk-confirm', authenticateToken, resolveWorkspace, portalController.bulkConfirmDeliveryRequests);
router.get('/manage/delivery-requests/unbilled', authenticateToken, resolveWorkspace, portalController.checkUnbilledDeliveryRequests);
router.delete('/manage/delivery-requests/:id', authenticateToken, resolveWorkspace, portalController.deleteAdminDeliveryRequest);

module.exports = router;
