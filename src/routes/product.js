// meat-management-be/src/routes/product.js
const express = require('express');
const router = express.Router();
const productController = require('../controllers/product');
const { authenticateToken, requirePermission, resolveWorkspace } = require('../middlewares/auth');

// Bảo vệ tất cả các API quản lý sản phẩm bằng middleware xác thực token và quyền
router.use(authenticateToken);
router.use(resolveWorkspace); // Chuyển hướng userId sang workspace owner nếu là nhân viên
router.use(requirePermission('canManageCustomers'));

// Lấy danh sách sản phẩm hoạt động
router.get('/', productController.getProducts);

// Lấy danh sách giá thịt của các khách hàng được cập nhật trong ngày
router.get('/daily-price-updates', productController.getDailyPriceUpdates);

// Cập nhật giá thịt riêng cho khách hàng
router.post('/customer-price', productController.updateCustomerProductPrice);

// Cập nhật giá bán và giá nhập đồng loạt cho nhiều loại thịt
router.post('/batch-update-prices', productController.batchUpdateProductPrices);

// Cập nhật giá thịt riêng đồng loạt cho một hoặc nhiều khách hàng / nhóm khách
router.post('/batch-customer-prices', productController.batchUpdateCustomerProductPrices);

// Phân tích giá phổ biến nhất của từng sản phẩm theo nhóm cửa hàng
router.post('/group-price-analysis', productController.analyzeGroupPrices);

// Tạo sản phẩm mới
router.post('/', productController.createProduct);

// Cập nhật thông tin sản phẩm
router.put('/:id', productController.updateProduct);

// Xóa mềm (ẩn) sản phẩm
router.delete('/:id', productController.deleteProduct);

module.exports = router;
