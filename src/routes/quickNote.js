// meat-management-be/src/routes/quickNote.js
const express = require('express');
const router = express.Router();
const quickNoteController = require('../controllers/quickNote');
const { authenticateToken } = require('../middlewares/auth');

// Toàn bộ API ghi chú yêu cầu đăng nhập
router.use(authenticateToken);

// 1. Lấy ghi chú cần nhớ của người dùng
router.get('/', quickNoteController.getQuickNote);

// 2. Cập nhật ghi chú cần nhớ của người dùng
router.put('/', quickNoteController.updateQuickNote);

module.exports = router;
