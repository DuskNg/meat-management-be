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
        isWorkspaceOwner: true,
        canManageCustomers: true,
        canManageDebt: true,
        canManageBadDebt: true,
        canManageEmployees: true,
        canManageStore: true,
        canManageInventory: true,
        canManageShop: true,
        isActive: true,
        deletedAt: true,
        createdAt: true,
        updatedAt: true,
        ownedWorkspace: {
          select: { id: true, name: true, inviteCode: true, isActive: true },
        },
      },
      orderBy: [
        { isActive: 'desc' },
        { createdAt: 'desc' },
      ],
    });

    res.status(200).json({
      success: true,
      data: users,
    });
  } catch (error) {
    next(error);
  }
};

// 2. Xóa mềm một tài khoản người dùng
const softDeleteUser = async (req, res, next) => {
  try {
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new NotFoundError('Không tìm thấy tài khoản người dùng cần xóa.');
    }

    if (user.isAdmin) {
      throw new BadRequestError('Không thể xóa tài khoản Admin tối cao.');
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        isActive: false,
        deletedAt: new Date(),
      },
    });

    // Ghi log hoạt động của admin
    await logActivity(
      req.user.id,
      'SOFT_DELETE_USER',
      `Xóa tạm thời tài khoản ${user.name} (${user.phone})`
    );

    res.status(200).json({
      success: true,
      message: 'Xóa tạm thời tài khoản thành công. Tài khoản sẽ bị xóa vĩnh viễn sau 7 ngày.',
      data: {
        id: updatedUser.id,
        isActive: updatedUser.isActive,
        deletedAt: updatedUser.deletedAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 3. Khôi phục một tài khoản người dùng đã bị xóa mềm
const restoreUser = async (req, res, next) => {
  try {
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new NotFoundError('Không tìm thấy tài khoản người dùng cần khôi phục.');
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        isActive: true,
        deletedAt: null,
      },
    });

    // Ghi log hoạt động của admin
    await logActivity(
      req.user.id,
      'RESTORE_USER',
      `Khôi phục tài khoản ${user.name} (${user.phone})`
    );

    res.status(200).json({
      success: true,
      message: 'Khôi phục tài khoản người dùng thành công.',
      data: {
        id: updatedUser.id,
        isActive: updatedUser.isActive,
        deletedAt: updatedUser.deletedAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 4. Cập nhật phân quyền của một tài khoản người dùng
const updatePermissions = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { isWorkspaceOwner, canManageCustomers, canManageDebt, canManageBadDebt, canManageEmployees, canManageStore, canManageInventory, canManageShop } = req.body;

    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new NotFoundError('Không tìm thấy tài khoản người dùng cần cập nhật.');
    }

    if (user.isAdmin) {
      throw new BadRequestError('Không thể sửa quyền của tài khoản Admin tối cao.');
    }

    // Thiết lập các quyền một cách độc lập
    const isOwnerBool = isWorkspaceOwner !== undefined ? !!isWorkspaceOwner : undefined;
    const customersVal = canManageCustomers !== undefined ? !!canManageCustomers : undefined;
    const debtVal = canManageDebt !== undefined ? !!canManageDebt : undefined;
    const badDebtVal = canManageBadDebt !== undefined ? !!canManageBadDebt : undefined;
    const employeesVal = canManageEmployees !== undefined ? !!canManageEmployees : undefined;
    const storeVal = canManageStore !== undefined ? !!canManageStore : undefined;
    const inventoryVal = canManageInventory !== undefined ? !!canManageInventory : undefined;
    const shopVal = canManageShop !== undefined ? !!canManageShop : undefined;

    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        isWorkspaceOwner: isOwnerBool,
        canManageCustomers: customersVal,
        canManageDebt: debtVal,
        canManageBadDebt: badDebtVal,
        canManageEmployees: employeesVal,
        canManageStore: storeVal,
        canManageInventory: inventoryVal,
        canManageShop: shopVal,
      },
    });

    // Ghi log hoạt động phân quyền của admin
    await logActivity(
      req.user.id,
      'UPDATE_USER_PERMISSIONS',
      `Phân quyền cho tài khoản ${user.name} (${user.phone}): Chủ Workspace [${!!updatedUser.isWorkspaceOwner}], Khách hàng [${!!updatedUser.canManageCustomers}], Công nợ [${!!updatedUser.canManageDebt}], Nợ xấu [${!!updatedUser.canManageBadDebt}], Nhân viên [${!!updatedUser.canManageEmployees}], Cửa hàng [${!!updatedUser.canManageStore}], Kho [${!!updatedUser.canManageInventory}], Cửa hàng tính giờ [${!!updatedUser.canManageShop}]`
    );

    res.status(200).json({
      success: true,
      message: 'Cập nhật phân quyền tài khoản thành công.',
      data: {
        id: updatedUser.id,
        name: updatedUser.name,
        phone: updatedUser.phone,
        permissions: {
          isWorkspaceOwner: updatedUser.isWorkspaceOwner,
          canManageCustomers: updatedUser.canManageCustomers,
          canManageDebt: updatedUser.canManageDebt,
          canManageBadDebt: updatedUser.canManageBadDebt,
          canManageEmployees: updatedUser.canManageEmployees,
          canManageStore: updatedUser.canManageStore,
          canManageInventory: updatedUser.canManageInventory,
          canManageShop: updatedUser.canManageShop,
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

// 7. Admin bật/tắt quyền chủ Workspace cho một tài khoản
const toggleWorkspaceOwner = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { isWorkspaceOwner } = req.body;

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundError('Không tìm thấy tài khoản người dùng.');
    }
    if (user.isAdmin) {
      throw new BadRequestError('Không thể thay đổi quyền của tài khoản Admin tối cao.');
    }

    const isOwnerBool = !!isWorkspaceOwner;
    const updateData = { isWorkspaceOwner: isOwnerBool };

    const updated = await prisma.user.update({
      where: { id },
      data: updateData,
    });

    await logActivity(
      req.user.id,
      'TOGGLE_WORKSPACE_OWNER',
      `${isOwnerBool ? 'Cấp' : 'Thu hồi'} quyền Chủ Workspace cho tài khoản ${user.name} (${user.phone})`
    );

    res.status(200).json({
      success: true,
      message: `Đã ${isOwnerBool ? 'cấp' : 'thu hồi'} quyền Chủ Workspace cho ${user.name}.`,
      data: {
        id: updated.id,
        isWorkspaceOwner: updated.isWorkspaceOwner,
        canManageCustomers: updated.canManageCustomers,
        canManageDebt: updated.canManageDebt,
        canManageBadDebt: updated.canManageBadDebt,
        canManageEmployees: updated.canManageEmployees,
        canManageStore: updated.canManageStore,
        canManageInventory: updated.canManageInventory,
        canManageShop: updated.canManageShop,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getUsers,
  softDeleteUser,
  restoreUser,
  updatePermissions,
  getUserLogs,
  getUserAiUsage,
  toggleWorkspaceOwner,
};
