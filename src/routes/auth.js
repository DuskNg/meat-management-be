// meat-management-be/src/routes/auth.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth');
const { authenticateToken } = require('../middlewares/auth');

// Yêu cầu gửi mã OTP (Không cần đăng nhập)
router.post('/request-otp', authController.requestOtp);

// Xác thực mã OTP và cấp token (Không cần đăng nhập)
router.post('/verify-otp', authController.verifyOtp);

// Làm mới Access Token bằng Refresh Token (Không cần đăng nhập)
router.post('/refresh-token', authController.refreshToken);

// Đăng xuất và vô hiệu hóa token (Yêu cầu gửi refresh token)
router.post('/logout', authController.logout);

// Lấy thông tin hồ sơ chủ buôn (Yêu cầu đăng nhập)
router.get('/profile', authenticateToken, authController.getProfile);

// Cập nhật thông tin hồ sơ chủ buôn (Yêu cầu đăng nhập)
router.put('/profile', authenticateToken, authController.updateProfile);

module.exports = router;
