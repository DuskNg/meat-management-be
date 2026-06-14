// meat-management-be/src/routes/product.js
const express = require('express');
const router = express.Router();
const productController = require('../controllers/product');
const { authenticateToken } = require('../middlewares/auth');

// Bảo vệ tất cả các API quản lý sản phẩm bằng middleware xác thực token
router.use(authenticateToken);

// Lấy danh sách sản phẩm hoạt động
router.get('/', productController.getProducts);

// Tạo sản phẩm mới
router.post('/', productController.createProduct);

// Cập nhật thông tin sản phẩm
router.put('/:id', productController.updateProduct);

// Xóa mềm (ẩn) sản phẩm
router.delete('/:id', productController.deleteProduct);

module.exports = router;
