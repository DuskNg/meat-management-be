// meat-management-be/src/routes/auth.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth');

// Yêu cầu gửi mã OTP (Không cần đăng nhập)
router.post('/request-otp', authController.requestOtp);

// Xác thực mã OTP và cấp token (Không cần đăng nhập)
router.post('/verify-otp', authController.verifyOtp);

// Làm mới Access Token bằng Refresh Token (Không cần đăng nhập)
router.post('/refresh-token', authController.refreshToken);

// Đăng xuất và vô hiệu hóa token (Yêu cầu gửi refresh token)
router.post('/logout', authController.logout);

module.exports = router;
