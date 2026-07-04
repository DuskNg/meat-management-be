// meat-management-be/src/middlewares/auth.js
const jwt = require('jsonwebtoken');
const { UnauthorizedError, ForbiddenError } = require('../utils/errors');
const prisma = require('../utils/db');

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

// Middleware yêu cầu quyền Admin
const requireAdmin = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) {
      throw new UnauthorizedError('Yêu cầu phải xác thực tài khoản.');
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });

    if (!user || !user.isAdmin) {
      throw new ForbiddenError('Bạn không có quyền quản trị viên.');
    }

    next();
  } catch (error) {
    next(error);
  }
};

// Middleware yêu cầu phân quyền cụ thể
const requirePermission = (permissionField) => async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) {
      throw new UnauthorizedError('Yêu cầu phải xác thực tài khoản.');
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });

    if (!user) {
      throw new UnauthorizedError('Tài khoản không tồn tại.');
    }

    // Admin có toàn bộ quyền
    if (user.isAdmin) {
      return next();
    }

    // Kiểm tra quyền cụ thể
    if (!user[permissionField]) {
      throw new ForbiddenError('Tài khoản của bạn không được cấp quyền thực hiện chức năng này.');
    }

    next();
  } catch (error) {
    next(error);
  }
};

module.exports = {
  authenticateToken,
  requireAdmin,
  requirePermission,
};
