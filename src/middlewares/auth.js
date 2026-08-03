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

      // Hỗ trợ Admin ghi đè quyền để xem và quản lý Workspace của chủ tài khoản khác
      const overrideUserId = req.headers['x-user-override'];
      if (decodedUser.isAdmin && overrideUserId) {
        req.user = {
          ...decodedUser,
          id: overrideUserId,
          isAdmin: false, // Hoạt động dưới danh nghĩa tài khoản được ghi đè
        };
      }

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

    if (!user || !user.isAdmin || !user.isActive) {
      throw new ForbiddenError('Bạn không có quyền quản trị viên hoặc tài khoản đã bị khóa/xóa.');
    }

    next();
  } catch (error) {
    next(error);
  }
};

// Middleware kiểm tra quyền hạn cụ thể
const requirePermission = (permissionField) => async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) {
      throw new UnauthorizedError('Yêu cầu phải xác thực tài khoản.');
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedError('Tài khoản không tồn tại hoặc đã bị khóa/xóa.');
    }

    // Admin có toàn bộ quyền
    if (user.isAdmin) {
      return next();
    }

    // Nếu là thành viên workspace → kiểm tra quyền theo workspace member
    if (req.workspaceMember) {
      if (!req.workspaceMember[permissionField]) {
        throw new ForbiddenError('Bạn không được cấp quyền thực hiện chức năng này trong Workspace.');
      }
      return next();
    }

    // Kiểm tra quyền cụ thể của tài khoản thường
    if (!user[permissionField]) {
      throw new ForbiddenError('Tài khoản của bạn không được cấp quyền thực hiện chức năng này.');
    }

    next();
  } catch (error) {
    next(error);
  }
};

// Middleware giải quyết Workspace — gắn effectiveUserId và actorId vào request
// Nếu user là thành viên của một workspace: effectiveUserId = ownerId (dùng data của chủ)
// Nếu user thường: effectiveUserId = req.user.id (không thay đổi gì, tương thích ngược)
const resolveWorkspace = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) {
      req.effectiveUserId = null;
      req.actorId = null;
      req.workspaceMember = null;
      return next();
    }

    const actorId = req.user.id;

    // Tìm membership của user trong bất kỳ workspace nào
    const membership = await prisma.workspaceMember.findFirst({
      where: { userId: actorId },
      include: {
        workspace: {
          select: {
            id: true,
            ownerId: true,
            name: true,
            isActive: true,
          },
        },
      },
    });

    if (membership && membership.workspace && membership.workspace.isActive) {
      // Thành viên workspace → dùng data của chủ workspace nhưng log theo actorId
      req.effectiveUserId = membership.workspace.ownerId;
      req.actorId = actorId;
      req.workspaceMember = membership; // Chứa permissions để kiểm tra quyền
    } else {
      // User thường — hoàn toàn như cũ
      req.effectiveUserId = actorId;
      req.actorId = actorId;
      req.workspaceMember = null;
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
  resolveWorkspace,
};

