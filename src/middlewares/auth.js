// meat-management-be/src/middlewares/auth.js
const jwt = require('jsonwebtoken');
const { UnauthorizedError, ForbiddenError } = require('../utils/errors');
const prisma = require('../utils/db');

// Bộ nhớ đệm ngắn hạn (5 giây) cho thông tin User & Workspace nhằm giảm tải round-trip DB trên mỗi API call
const AUTH_CACHE_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 5000;
const userCache = new Map(); // userId -> { data, expiresAt }
const workspaceCache = new Map(); // actorId -> { data, expiresAt }

const getCachedUser = async (userId) => {
  if (AUTH_CACHE_TTL_MS > 0) {
    const cached = userCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (AUTH_CACHE_TTL_MS > 0 && user) {
    userCache.set(userId, { data: user, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
  }
  return user;
};

const getCachedMembership = async (actorId) => {
  if (AUTH_CACHE_TTL_MS > 0) {
    const cached = workspaceCache.get(actorId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
  }
  const membership = await prisma.workspaceMember.findFirst({
    where: { userId: actorId },
    include: {
      workspace: {
        include: {
          owner: {
            select: {
              id: true,
              isAdmin: true,
              isActive: true,
              canManageCustomers: true,
              canManageDebt: true,
              canManageBadDebt: true,
              canManageEmployees: true,
              canManageStore: true,
              canManageInventory: true,
              canManageShop: true,
              canManageProfit: true,
              canManageTransactions: true,
            },
          },
        },
      },
    },
  });
  if (AUTH_CACHE_TTL_MS > 0) {
    workspaceCache.set(actorId, { data: membership, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
  }
  return membership;
};

// Xóa cache xác thực khi có thay đổi quyền hoặc thành viên workspace
const invalidateAuthCache = (userId) => {
  if (userId) {
    userCache.delete(userId);
    workspaceCache.delete(userId);
  } else {
    userCache.clear();
    workspaceCache.clear();
  }
};

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

    const user = await getCachedUser(req.user.id);

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

    const user = await getCachedUser(req.user.id);

    if (!user || !user.isActive) {
      throw new UnauthorizedError('Tài khoản không tồn tại hoặc đã bị khóa/xóa.');
    }

    req.authUser = user;
    if (!req.effectiveUser) {
      req.effectiveUser = user;
    }

    // Admin có toàn bộ quyền
    if (user.isAdmin) {
      return next();
    }

    // Nếu là thành viên workspace → kiểm tra quyền giao giữa workspace member và chủ workspace
    if (req.workspaceMember) {
      if (!req.workspaceMember[permissionField]) {
        throw new ForbiddenError('Bạn không được cấp quyền thực hiện chức năng này trong Workspace.');
      }
      const owner = req.workspaceMember.workspace.owner;
      if (!owner || !owner[permissionField]) {
        throw new ForbiddenError('Chủ Workspace hiện tại không sở hữu hoặc đã bị thu hồi quyền này.');
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

    // Tìm membership của user trong bất kỳ workspace nào, kèm theo quyền của chủ workspace để kiểm tra chéo
    const membership = await getCachedMembership(actorId);

    if (membership && membership.workspace && membership.workspace.isActive) {
      // Thành viên workspace → dùng data của chủ workspace nhưng log theo actorId
      req.effectiveUserId = membership.workspace.ownerId;
      req.actorId = actorId;
      req.workspaceMember = membership; // Chứa permissions để kiểm tra quyền
      req.effectiveUser = membership.workspace.owner;
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
  invalidateAuthCache,
};

