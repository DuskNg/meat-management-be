// meat-management-be/src/controllers/admin.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');

// 1. Lấy danh sách toàn bộ tài khoản sử dụng ứng dụng (loại trừ tài khoản admin hiện tại)
const getUsers = async (req, res, next) => {
  try {
    const adminId = req.user.id;

    const users = await prisma.user.findMany({
      where: {
        id: { not: adminId }, // Không lấy tài khoản admin đang đăng nhập
      },
      select: {
        id: true,
        name: true,
        phone: true,
        isAdmin: true,
        canManageCustomers: true,
        canManageDebt: true,
        canManageBadDebt: true,
        canManageEmployees: true,
        canManageStore: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.status(200).json({
      success: true,
      data: users,
    });
  } catch (error) {
    next(error);
  }
};

// 2. Cập nhật phân quyền của một tài khoản người dùng
const updatePermissions = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { canManageCustomers, canManageDebt, canManageBadDebt, canManageEmployees, canManageStore } = req.body;

    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new NotFoundError('Không tìm thấy tài khoản người dùng cần cập nhật.');
    }

    if (user.isAdmin) {
      throw new BadRequestError('Không thể sửa quyền của tài khoản Admin tối cao.');
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        canManageCustomers: canManageCustomers !== undefined ? !!canManageCustomers : undefined,
        canManageDebt: canManageDebt !== undefined ? !!canManageDebt : undefined,
        canManageBadDebt: canManageBadDebt !== undefined ? !!canManageBadDebt : undefined,
        canManageEmployees: canManageEmployees !== undefined ? !!canManageEmployees : undefined,
        canManageStore: canManageStore !== undefined ? !!canManageStore : undefined,
      },
    });

    // Ghi log hoạt động phân quyền của admin
    await logActivity(
      req.user.id,
      'UPDATE_USER_PERMISSIONS',
      `Phân quyền cho tài khoản ${user.name} (${user.phone}): Khách hàng [${!!canManageCustomers}], Công nợ [${!!canManageDebt}], Nợ xấu [${!!canManageBadDebt}], Nhân viên [${!!canManageEmployees}], Cửa hàng [${!!canManageStore}]`
    );

    res.status(200).json({
      success: true,
      message: 'Cập nhật phân quyền tài khoản thành công.',
      data: {
        id: updatedUser.id,
        name: updatedUser.name,
        phone: updatedUser.phone,
        permissions: {
          canManageCustomers: updatedUser.canManageCustomers,
          canManageDebt: updatedUser.canManageDebt,
          canManageBadDebt: updatedUser.canManageBadDebt,
          canManageEmployees: updatedUser.canManageEmployees,
          canManageStore: updatedUser.canManageStore,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// 3. Xem logs hoạt động của một tài khoản theo ngày
const getUserLogs = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { date } = req.query; // Định dạng 'YYYY-MM-DD' hoặc rỗng

    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new NotFoundError('Không tìm thấy tài khoản người dùng.');
    }

    const whereClause = { userId: id };

    // Lọc theo ngày nếu có
    if (date) {
      const startDate = new Date(`${date}T00:00:00.000Z`);
      const endDate = new Date(`${date}T23:59:59.999Z`);
      whereClause.createdAt = {
        gte: startDate,
        lte: endDate,
      };
    }

    const logs = await prisma.activityLog.findMany({
      where: whereClause,
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.status(200).json({
      success: true,
      data: logs,
    });
  } catch (error) {
    next(error);
  }
};

// 4. Xem lịch sử và tổng chi phí voice/chụp tích kê của một tài khoản
const getUserAiUsage = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { date } = req.query;

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundError('Không tìm thấy tài khoản người dùng.');
    }

    // 1. Tính toán tổng chi phí AI tích lũy trọn đời (tất cả các ngày)
    const allLogs = await prisma.activityLog.findMany({
      where: { userId: id, action: 'AI_USAGE' },
    });

    const allRecords = allLogs.map((log) => {
      try {
        return JSON.parse(log.details);
      } catch {
        return null;
      }
    }).filter(Boolean);

    const allTimeSummary = allRecords.reduce((result, record) => ({
      requestCount: result.requestCount + 1,
      costUsd: result.costUsd + (Number(record.costUsd) || 0),
      totalTokens: result.totalTokens + (Number(record.totalTokens) || 0),
    }), {
      requestCount: 0,
      costUsd: 0,
      totalTokens: 0,
    });

    // 2. Lấy dữ liệu chi tiết của ngày lọc hiện tại
    const whereClause = { userId: id };
    if (date) {
      const startDate = new Date(`${date}T00:00:00.000Z`);
      const endDate = new Date(`${date}T23:59:59.999Z`);
      whereClause.createdAt = { gte: startDate, lte: endDate };
    }

    const logs = await prisma.activityLog.findMany({
      where: { ...whereClause, action: 'AI_USAGE' },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    const records = logs.map((log) => {
      try {
        return { id: log.id, createdAt: log.createdAt, ...JSON.parse(log.details) };
      } catch {
        return null;
      }
    }).filter(Boolean);

    const summary = records.reduce((result, record) => ({
      requestCount: result.requestCount + 1,
      costUsd: result.costUsd + (Number(record.costUsd) || 0),
      inputTokens: result.inputTokens + (Number(record.inputTokens) || 0),
      outputTokens: result.outputTokens + (Number(record.outputTokens) || 0),
      totalTokens: result.totalTokens + (Number(record.totalTokens) || 0),
    }), {
      requestCount: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });

    res.status(200).json({
      success: true,
      data: {
        records,
        summary,
        allTimeSummary,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getUsers,
  updatePermissions,
  getUserLogs,
  getUserAiUsage,
};
