// meat-management-be/src/middlewares/auth.js
const jwt = require('jsonwebtoken');
const { UnauthorizedError } = require('../utils/errors');

// Middleware xác thực Access Token từ Header
const authenticateToken = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    // Lấy chuỗi Token sau chữ "Bearer "
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      throw new UnauthorizedError('Yêu cầu phải có Access Token để truy cập.');
    }

    // Xác thực tính hợp lệ của Token
    jwt.verify(token, process.env.JWT_ACCESS_SECRET || 'default_access_secret', (err, decodedUser) => {
      if (err) {
        // Phân biệt lỗi Token hết hạn và Token không hợp lệ
        if (err.name === 'TokenExpiredError') {
          return next(new UnauthorizedError('Access Token đã hết hạn.', 'TOKEN_EXPIRED'));
        }
        return next(new UnauthorizedError('Access Token không hợp lệ.'));
      }

      // Gắn thông tin người dùng đã giải mã vào object request
      req.user = decodedUser;
      next();
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  authenticateToken,
};
