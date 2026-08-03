// meat-management-be/src/routes/supplier.js
const express = require('express');
const router = express.Router();
const supplierController = require('../controllers/supplier');
const { authenticateToken, requirePermission, resolveWorkspace } = require('../middlewares/auth');

// Bảo vệ tất cả các tuyến đường bằng middleware xác thực token và quyền
router.use(authenticateToken);
router.use(resolveWorkspace); // Chuyển hướng userId sang workspace owner nếu là nhân viên
router.use(requirePermission('canManageDebt'));

// Lấy danh sách toàn bộ nhà cung cấp kèm công nợ
router.get('/', supplierController.getSuppliers);

// Tạo mới nhà cung cấp
router.post('/', supplierController.createSupplier);

// Cập nhật thông tin nhà cung cấp
router.put('/:id', supplierController.updateSupplier);

// Xóa mềm nhà cung cấp
router.delete('/:id', supplierController.deleteSupplier);

// Lấy lịch sử dòng chảy nợ và thanh toán của một nhà cung cấp
router.get('/:id/history', supplierController.getSupplierHistory);

// Tạo giao dịch nhập hàng (ghi nhận thêm nợ của chủ sạp đối với nhà cung cấp)
router.post('/transactions', supplierController.createSupplierTransaction);

// Tạo giao dịch trả nợ (ghi nhận thanh toán cho nhà cung cấp)
router.post('/payments', supplierController.createSupplierPayment);

module.exports = router;
