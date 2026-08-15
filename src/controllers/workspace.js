// meat-management-be/src/controllers/workspace.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, ForbiddenError, ConflictError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');
const crypto = require('crypto');

// Tạo mã mời ngẫu nhiên 8 ký tự (chữ hoa + số)
const generateInviteCode = () => {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
};

// 1. Chủ tạo Workspace (chỉ dùng được nếu isWorkspaceOwner = true)
const createWorkspace = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { name } = req.body;

    if (!name || !name.trim()) {
      throw new BadRequestError('Tên workspace là bắt buộc.');
    }

    // Kiểm tra quyền tạo workspace
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) {
      throw new NotFoundError('Không tìm thấy tài khoản.');
    }
    if (!user.isWorkspaceOwner && !user.isAdmin) {
      throw new ForbiddenError('Tài khoản của bạn không được phép tạo Workspace. Vui lòng liên hệ Admin.');
    }

    // Kiểm tra xem đã có workspace chưa
    const existing = await prisma.workspace.findUnique({ where: { ownerId: userId } });
    if (existing) {
      throw new ConflictError('Bạn đã có một Workspace rồi. Mỗi tài khoản chỉ được tạo 1 Workspace.');
    }

    // Tạo mã mời duy nhất
    let inviteCode;
    let isUnique = false;
    while (!isUnique) {
      inviteCode = generateInviteCode();
      const exists = await prisma.workspace.findUnique({ where: { inviteCode } });
      if (!exists) isUnique = true;
    }

    const workspace = await prisma.workspace.create({
      data: {
        ownerId: userId,
        name: name.trim(),
        inviteCode,
      },
    });

    await logActivity(userId, 'CREATE_WORKSPACE', `Tạo Workspace: "${workspace.name}" với mã mời ${workspace.inviteCode}`);

    res.status(201).json({
      success: true,
      message: 'Tạo Workspace thành công.',
      data: workspace,
    });
  } catch (error) {
    next(error);
  }
};

// 2. Lấy thông tin workspace của chủ (kèm members và pending requests)
const getMyWorkspace = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const workspace = await prisma.workspace.findUnique({
      where: { ownerId: userId },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, name: true, phone: true },
            },
          },
          orderBy: { joinedAt: 'asc' },
        },
        joinRequests: {
          where: { status: 'pending' },
          include: {
            user: {
              select: { id: true, name: true, phone: true },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!workspace) {
      return res.status(200).json({
        success: true,
        data: null,
        message: 'Bạn chưa có Workspace. Hãy tạo mới.',
      });
    }

    res.status(200).json({
      success: true,
      data: workspace,
    });
  } catch (error) {
    next(error);
  }
};

// 3. Lấy danh sách yêu cầu đang chờ (dùng cho polling thông báo — gọn nhẹ)
const getPendingRequests = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const workspace = await prisma.workspace.findUnique({ where: { ownerId: userId } });
    if (!workspace) {
      return res.status(200).json({ success: true, data: [], count: 0 });
    }

    const requests = await prisma.workspaceJoinRequest.findMany({
      where: { workspaceId: workspace.id, status: 'pending' },
      include: {
        user: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.status(200).json({
      success: true,
      data: requests,
      count: requests.length,
    });
  } catch (error) {
    next(error);
  }
};

// 4. Nhân viên gửi yêu cầu tham gia workspace qua inviteCode
const joinWorkspace = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { inviteCode } = req.body;

    if (!inviteCode || !inviteCode.trim()) {
      throw new BadRequestError('Mã mời là bắt buộc.');
    }

    // Tìm workspace theo mã mời
    const workspace = await prisma.workspace.findUnique({
      where: { inviteCode: inviteCode.trim().toUpperCase() },
      include: { owner: { select: { name: true } } },
    });

    if (!workspace || !workspace.isActive) {
      throw new NotFoundError('Mã mời không hợp lệ hoặc workspace đã bị tắt.');
    }

    // Không thể tự gia nhập workspace của chính mình
    if (workspace.ownerId === userId) {
      throw new BadRequestError('Bạn là chủ của Workspace này, không cần tham gia.');
    }

    // Kiểm tra đã là thành viên chưa
    const existingMember = await prisma.workspaceMember.findFirst({
      where: { workspaceId: workspace.id, userId },
    });
    if (existingMember) {
      return res.status(200).json({
        success: true,
        status: 'already_member',
        message: `Bạn đã là thành viên của Workspace "${workspace.name}" rồi.`,
        data: { workspaceName: workspace.name, ownerName: workspace.owner.name },
      });
    }

    // Kiểm tra yêu cầu đang chờ
    const existingRequest = await prisma.workspaceJoinRequest.findFirst({
      where: { workspaceId: workspace.id, userId },
    });

    if (existingRequest) {
      if (existingRequest.status === 'pending') {
        return res.status(200).json({
          success: true,
          status: 'pending',
          message: `Yêu cầu của bạn đang chờ phê duyệt từ chủ Workspace "${workspace.name}".`,
          data: { requestId: existingRequest.id, workspaceName: workspace.name, ownerName: workspace.owner.name },
        });
      }
      if (existingRequest.status === 'rejected') {
        // Reset yêu cầu bị từ chối để gửi lại
        await prisma.workspaceJoinRequest.update({
          where: { id: existingRequest.id },
          data: { status: 'pending', updatedAt: new Date() },
        });
        return res.status(200).json({
          success: true,
          status: 'pending',
          message: `Đã gửi lại yêu cầu tham gia Workspace "${workspace.name}". Vui lòng chờ phê duyệt.`,
          data: { requestId: existingRequest.id, workspaceName: workspace.name, ownerName: workspace.owner.name },
        });
      }
    }

    // Tạo yêu cầu mới
    const joinRequest = await prisma.workspaceJoinRequest.create({
      data: {
        workspaceId: workspace.id,
        userId,
        status: 'pending',
      },
    });

    res.status(201).json({
      success: true,
      status: 'pending',
      message: `Yêu cầu tham gia Workspace "${workspace.name}" đã được gửi. Vui lòng chờ chủ phê duyệt.`,
      data: { requestId: joinRequest.id, workspaceName: workspace.name, ownerName: workspace.owner.name },
    });
  } catch (error) {
    next(error);
  }
};

// 5. Nhân viên kiểm tra trạng thái yêu cầu tham gia của mình
const getJoinStatus = async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Kiểm tra xem đã là thành viên chưa
    const membership = await prisma.workspaceMember.findFirst({
      where: { userId },
      include: {
        workspace: {
          select: {
            id: true,
            name: true,
            ownerId: true,
            owner: { select: { name: true } },
          },
        },
      },
    });

    if (membership) {
      return res.status(200).json({
        success: true,
        status: 'approved',
        data: {
          workspaceId: membership.workspaceId,
          workspaceName: membership.workspace.name,
          ownerName: membership.workspace.owner.name,
          permissions: {
            canManageCustomers: membership.canManageCustomers,
            canManageDebt: membership.canManageDebt,
            canManageBadDebt: membership.canManageBadDebt,
            canManageEmployees: membership.canManageEmployees,
            canManageStore: membership.canManageStore,
            canManageInventory: membership.canManageInventory,
            canManageShop: membership.canManageShop,
          },
        },
      });
    }

    // Kiểm tra yêu cầu đang chờ
    const request = await prisma.workspaceJoinRequest.findFirst({
      where: { userId, status: 'pending' },
      include: {
        workspace: {
          select: { name: true, owner: { select: { name: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (request) {
      return res.status(200).json({
        success: true,
        status: 'pending',
        data: {
          requestId: request.id,
          workspaceName: request.workspace.name,
          ownerName: request.workspace.owner.name,
        },
      });
    }

    res.status(200).json({
      success: true,
      status: 'none',
      data: null,
    });
  } catch (error) {
    next(error);
  }
};

// 6. Chủ phê duyệt yêu cầu tham gia
const approveJoinRequest = async (req, res, next) => {
  try {
    const ownerId = req.user.id;
    const { requestId } = req.params;

    // Lấy workspace của chủ kèm thông tin quyền của chủ
    const workspace = await prisma.workspace.findUnique({
      where: { ownerId },
      include: {
        owner: {
          select: {
            canManageCustomers: true,
            canManageDebt: true,
            canManageBadDebt: true,
            canManageEmployees: true,
            canManageStore: true,
            canManageInventory: true,
            canManageShop: true,
          },
        },
      },
    });
    if (!workspace) {
      throw new NotFoundError('Bạn chưa có Workspace.');
    }

    // Lấy yêu cầu tham gia
    const request = await prisma.workspaceJoinRequest.findUnique({
      where: { id: requestId },
      include: { user: { select: { id: true, name: true, phone: true } } },
    });

    if (!request || request.workspaceId !== workspace.id) {
      throw new NotFoundError('Không tìm thấy yêu cầu tham gia.');
    }
    if (request.status !== 'pending') {
      throw new BadRequestError('Yêu cầu này đã được xử lý rồi.');
    }

    // Thiết lập quyền mặc định tối thiểu cho thành viên mới (chỉ cấp quyền quản lý Khách hàng nếu Chủ có quyền)
    const ownerPerms = workspace.owner;
    const defaultPermissions = {
      canManageCustomers: (ownerPerms.canManageCustomers === true),
      canManageDebt: false,
      canManageBadDebt: false,
      canManageEmployees: false,
      canManageStore: false,
      canManageInventory: false,
      canManageShop: false,
    };

    // Tạo thành viên với quyền được sao chép từ chủ và cập nhật trạng thái yêu cầu
    await prisma.$transaction([
      prisma.workspaceJoinRequest.update({
        where: { id: requestId },
        data: { status: 'approved' },
      }),
      prisma.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: request.userId } },
        create: { workspaceId: workspace.id, userId: request.userId, ...defaultPermissions },
        update: {},
      }),
      prisma.user.update({
        where: { id: request.userId },
        data: defaultPermissions,
      }),
    ]);

    await logActivity(
      ownerId,
      'APPROVE_WORKSPACE_JOIN',
      `Phê duyệt ${request.user.name} (${request.user.phone}) tham gia Workspace "${workspace.name}" với quyền mặc định tối thiểu`
    );

    res.status(200).json({
      success: true,
      message: `Đã phê duyệt ${request.user.name} tham gia Workspace.`,
    });
  } catch (error) {
    next(error);
  }
};

// 7. Chủ từ chối yêu cầu tham gia
const rejectJoinRequest = async (req, res, next) => {
  try {
    const ownerId = req.user.id;
    const { requestId } = req.params;

    const workspace = await prisma.workspace.findUnique({ where: { ownerId } });
    if (!workspace) throw new NotFoundError('Bạn chưa có Workspace.');

    const request = await prisma.workspaceJoinRequest.findUnique({
      where: { id: requestId },
      include: { user: { select: { id: true, name: true, phone: true } } },
    });

    if (!request || request.workspaceId !== workspace.id) {
      throw new NotFoundError('Không tìm thấy yêu cầu tham gia.');
    }
    if (request.status !== 'pending') {
      throw new BadRequestError('Yêu cầu này đã được xử lý rồi.');
    }

    await prisma.workspaceJoinRequest.update({
      where: { id: requestId },
      data: { status: 'rejected' },
    });

    await logActivity(
      ownerId,
      'REJECT_WORKSPACE_JOIN',
      `Từ chối ${request.user.name} (${request.user.phone}) tham gia Workspace "${workspace.name}"`
    );

    res.status(200).json({
      success: true,
      message: `Đã từ chối yêu cầu của ${request.user.name}.`,
    });
  } catch (error) {
    next(error);
  }
};

// 8. Chủ cập nhật quyền thành viên
const updateMemberPermissions = async (req, res, next) => {
  try {
    const ownerId = req.user.id;
    const { memberId } = req.params;
    const {
      canManageCustomers,
      canManageDebt,
      canManageBadDebt,
      canManageEmployees,
      canManageStore,
      canManageInventory,
      canManageShop,
    } = req.body;

    const workspace = await prisma.workspace.findUnique({ where: { ownerId } });
    if (!workspace) throw new NotFoundError('Bạn chưa có Workspace.');

    const member = await prisma.workspaceMember.findUnique({
      where: { id: memberId },
      include: { user: { select: { name: true, phone: true } } },
    });

    if (!member || member.workspaceId !== workspace.id) {
      throw new NotFoundError('Không tìm thấy thành viên trong Workspace của bạn.');
    }

    const updated = await prisma.workspaceMember.update({
      where: { id: memberId },
      data: {
        canManageCustomers: canManageCustomers !== undefined ? !!canManageCustomers : undefined,
        canManageDebt: canManageDebt !== undefined ? !!canManageDebt : undefined,
        canManageBadDebt: canManageBadDebt !== undefined ? !!canManageBadDebt : undefined,
        canManageEmployees: canManageEmployees !== undefined ? !!canManageEmployees : undefined,
        canManageStore: canManageStore !== undefined ? !!canManageStore : undefined,
        canManageInventory: canManageInventory !== undefined ? !!canManageInventory : undefined,
        canManageShop: canManageShop !== undefined ? !!canManageShop : undefined,
      },
    });

    // Đồng bộ sang bảng User để frontend của nhân viên nhận diện đúng quyền
    await prisma.user.update({
      where: { id: member.userId },
      data: {
        canManageCustomers: canManageCustomers !== undefined ? !!canManageCustomers : undefined,
        canManageDebt: canManageDebt !== undefined ? !!canManageDebt : undefined,
        canManageBadDebt: canManageBadDebt !== undefined ? !!canManageBadDebt : undefined,
        canManageEmployees: canManageEmployees !== undefined ? !!canManageEmployees : undefined,
        canManageStore: canManageStore !== undefined ? !!canManageStore : undefined,
        canManageInventory: canManageInventory !== undefined ? !!canManageInventory : undefined,
        canManageShop: canManageShop !== undefined ? !!canManageShop : undefined,
      },
    });

    await logActivity(
      ownerId,
      'UPDATE_WORKSPACE_MEMBER_PERMISSIONS',
      `Cập nhật quyền cho ${member.user.name} (${member.user.phone}) trong Workspace`
    );

    res.status(200).json({
      success: true,
      message: 'Cập nhật quyền thành viên thành công.',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

// 9. Chủ kick thành viên ra khỏi workspace
const kickMember = async (req, res, next) => {
  try {
    const ownerId = req.user.id;
    const { memberId } = req.params;

    const workspace = await prisma.workspace.findUnique({ where: { ownerId } });
    if (!workspace) throw new NotFoundError('Bạn chưa có Workspace.');

    const member = await prisma.workspaceMember.findUnique({
      where: { id: memberId },
      include: { user: { select: { id: true, name: true, phone: true } } },
    });

    if (!member || member.workspaceId !== workspace.id) {
      throw new NotFoundError('Không tìm thấy thành viên trong Workspace của bạn.');
    }

    // Cấu hình reset quyền về false
    const resetPermissions = {
      canManageCustomers: false,
      canManageDebt: false,
      canManageBadDebt: false,
      canManageEmployees: false,
      canManageStore: false,
      canManageInventory: false,
      canManageShop: false,
    };

    // Xóa thành viên, đặt lại yêu cầu thành rejected và reset quyền trong bảng User về false
    await prisma.$transaction([
      prisma.workspaceMember.delete({ where: { id: memberId } }),
      prisma.workspaceJoinRequest.updateMany({
        where: { workspaceId: workspace.id, userId: member.userId },
        data: { status: 'rejected' },
      }),
      prisma.user.update({
        where: { id: member.userId },
        data: resetPermissions,
      }),
    ]);

    await logActivity(
      ownerId,
      'KICK_WORKSPACE_MEMBER',
      `Loại ${member.user.name} (${member.user.phone}) khỏi Workspace "${workspace.name}"`
    );

    res.status(200).json({
      success: true,
      message: `Đã loại ${member.user.name} khỏi Workspace.`,
    });
  } catch (error) {
    next(error);
  }
};

// 10. Nhân viên tự rời workspace
const leaveWorkspace = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const membership = await prisma.workspaceMember.findFirst({
      where: { userId },
      include: { workspace: { select: { name: true } } },
    });

    if (!membership) {
      throw new NotFoundError('Bạn không phải là thành viên của Workspace nào.');
    }

    // Cấu hình reset quyền về false
    const resetPermissions = {
      canManageCustomers: false,
      canManageDebt: false,
      canManageBadDebt: false,
      canManageEmployees: false,
      canManageStore: false,
      canManageInventory: false,
      canManageShop: false,
    };

    // Xóa thành viên và reset quyền trong bảng User về false
    await prisma.$transaction([
      prisma.workspaceMember.delete({ where: { id: membership.id } }),
      prisma.user.update({
        where: { id: userId },
        data: resetPermissions,
      }),
    ]);

    await logActivity(
      userId,
      'LEAVE_WORKSPACE',
      `Rời khỏi Workspace "${membership.workspace.name}"`
    );

    res.status(200).json({
      success: true,
      message: `Đã rời khỏi Workspace "${membership.workspace.name}" thành công.`,
    });
  } catch (error) {
    next(error);
  }
};

// 11. Cập nhật tên Workspace
const updateWorkspace = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { name } = req.body;

    if (!name || !name.trim()) {
      throw new BadRequestError('Tên workspace là bắt buộc.');
    }

    const workspace = await prisma.workspace.findUnique({
      where: { ownerId: userId },
    });

    if (!workspace) {
      throw new NotFoundError('Không tìm thấy Workspace.');
    }

    const updatedWorkspace = await prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        name: name.trim(),
      },
    });

    await logActivity(userId, 'UPDATE_WORKSPACE_NAME', `Cập nhật tên Workspace thành: "${updatedWorkspace.name}"`);

    res.status(200).json({
      success: true,
      message: 'Cập nhật tên Workspace thành công.',
      data: updatedWorkspace,
    });
  } catch (error) {
    next(error);
  }
};

// 12. Chủ Workspace xem toàn bộ các thao tác/hành vi của các thành viên trong ngày
const getMemberActions = async (req, res, next) => {
  try {
    const ownerId = req.user.id;
    const { date, memberId, type } = req.query;

    // Tìm workspace do user làm chủ
    const workspace = await prisma.workspace.findUnique({
      where: { ownerId },
      include: {
        owner: {
          select: { id: true, name: true, phone: true },
        },
        members: {
          include: {
            user: {
              select: { id: true, name: true, phone: true },
            },
          },
        },
      },
    });

    if (!workspace) {
      throw new NotFoundError('Bạn không phải là Chủ của Workspace nào.');
    }

    // Danh sách các thành viên trong workspace (bao gồm cả chủ workspace)
    const memberUsers = [
      { id: workspace.owner.id, name: workspace.owner.name + ' (Chủ)', phone: workspace.owner.phone },
      ...workspace.members.map((m) => m.user),
    ];
    const memberUserMap = new Map(memberUsers.map((u) => [u.id, u]));

    // Xác định danh sách ID người dùng cần truy vấn (bao gồm cả chủ)
    let targetUserIds = [workspace.ownerId, ...workspace.members.map((m) => m.userId)];
    if (memberId && memberId !== 'ALL') {
      targetUserIds = targetUserIds.filter((id) => id === memberId);
    }

    if (targetUserIds.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          summary: {
            totalActions: 0,
            totalDebtCreated: 0,
            totalMoneyCollected: 0,
          },
          members: memberUsers,
          actions: [],
        },
      });
    }

    // Xác định khoảng thời gian ngày cần lọc (mặc định hôm nay nếu không truyền)
    let startDate, endDate;
    if (date) {
      startDate = new Date(`${date}T00:00:00.000Z`);
      endDate = new Date(`${date}T23:59:59.999Z`);
    } else {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      startDate = new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
      endDate = new Date(`${yyyy}-${mm}-${dd}T23:59:59.999Z`);
    }

    const actions = [];
    let totalDebtCreated = 0;
    let totalMoneyCollected = 0;

    // 1. Đơn nợ thịt (Transactions)
    const shouldFetchTransactions = !type || type === 'ALL' || type === 'TRANSACTION';
    if (shouldFetchTransactions) {
      const transactions = await prisma.transaction.findMany({
        where: {
          userId: ownerId,
          type: 'customer',
          createdBy: { in: targetUserIds },
          createdAt: { gte: startDate, lte: endDate },
        },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          items: {
            include: {
              product: { select: { id: true, name: true, unit: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      for (const tx of transactions) {
        const actor = memberUserMap.get(tx.createdBy) || { id: tx.createdBy, name: 'Nhân viên', phone: '' };
        const amountNum = parseFloat(tx.totalAmount) || 0;
        totalDebtCreated += amountNum;

        const itemDetails = (tx.items || [])
          .map((i) => `${i.product?.name || 'Mặt hàng'}: ${parseFloat(i.quantity)}${i.product?.unit || 'kg'} x ${parseFloat(i.price).toLocaleString('vi-VN')}đ = ${parseFloat(i.amount).toLocaleString('vi-VN')}đ`)
          .join(', ');

        actions.push({
          id: tx.id,
          type: 'TRANSACTION',
          typeName: 'Đơn nợ thịt',
          actionTitle: `Ghi nợ cho khách ${tx.customer?.name || 'Ẩn'}: ${amountNum.toLocaleString('vi-VN')}đ`,
          actor,
          createdAt: tx.createdAt,
          amount: amountNum,
          details: itemDetails + (tx.note ? ` (Ghi chú: ${tx.note})` : ''),
          rawItem: tx,
          canEdit: true,
          canDelete: true,
        });
      }
    }

    // 2. Thu tiền nợ (Payments)
    const shouldFetchPayments = !type || type === 'ALL' || type === 'PAYMENT';
    if (shouldFetchPayments) {
      const payments = await prisma.payment.findMany({
        where: {
          customer: { userId: ownerId },
          type: 'customer',
          createdBy: { in: targetUserIds },
          createdAt: { gte: startDate, lte: endDate },
        },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      for (const p of payments) {
        const actor = memberUserMap.get(p.createdBy) || { id: p.createdBy, name: 'Nhân viên', phone: '' };
        const amountNum = parseFloat(p.amount) || 0;
        totalMoneyCollected += amountNum;

        actions.push({
          id: p.id,
          type: 'PAYMENT',
          typeName: 'Thu tiền nợ',
          actionTitle: `Thu tiền từ khách ${p.customer?.name || 'Ẩn'}: ${amountNum.toLocaleString('vi-VN')}đ`,
          actor,
          createdAt: p.createdAt,
          amount: amountNum,
          details: `Đã thu: ${amountNum.toLocaleString('vi-VN')}đ vào lúc ${new Date(p.paidAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}` + (p.note ? ` (Ghi chú: ${p.note})` : ''),
          rawItem: p,
          canEdit: true,
          canDelete: true,
        });
      }
    }

    // 3. Khách hàng mới (Customers)
    const shouldFetchCustomers = !type || type === 'ALL' || type === 'CUSTOMER';
    if (shouldFetchCustomers) {
      const customers = await prisma.customer.findMany({
        where: {
          userId: ownerId,
          createdBy: { in: targetUserIds },
          createdAt: { gte: startDate, lte: endDate },
        },
        orderBy: { createdAt: 'desc' },
      });

      for (const c of customers) {
        const actor = memberUserMap.get(c.createdBy) || { id: c.createdBy, name: 'Nhân viên', phone: '' };
        actions.push({
          id: c.id,
          type: 'CUSTOMER',
          typeName: 'Thêm khách hàng',
          actionTitle: `Tạo khách hàng mới: ${c.name}`,
          actor,
          createdAt: c.createdAt,
          amount: parseFloat(c.manualDebt) || 0,
          details: `SĐT: ${c.phone || 'Chưa có'} | Địa chỉ: ${c.address || 'Chưa có'}${c.isBadDebt ? ' | Phân loại: Nợ xấu' : ''}` + (c.note ? ` (Ghi chú: ${c.note})` : ''),
          rawItem: c,
          canEdit: true,
          canDelete: true,
        });
      }
    }

    // 4. Hóa đơn bàn ăn / Cửa hàng (Store Transactions & Payments)
    const shouldFetchStore = !type || type === 'ALL' || type === 'STORE';
    if (shouldFetchStore) {
      const storeTransactions = await prisma.transaction.findMany({
        where: {
          userId: ownerId,
          type: 'store',
          createdBy: { in: targetUserIds },
          createdAt: { gte: startDate, lte: endDate },
        },
        include: {
          customer: { select: { id: true, name: true } },
          items: {
            include: {
              product: { select: { id: true, name: true, unit: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      for (const st of storeTransactions) {
        const actor = memberUserMap.get(st.createdBy) || { id: st.createdBy, name: 'Nhân viên', phone: '' };
        const amountNum = parseFloat(st.totalAmount) || 0;
        const itemDetails = (st.items || [])
          .map((i) => `${i.product?.name || 'Món'}: ${parseFloat(i.quantity)} x ${parseFloat(i.price).toLocaleString('vi-VN')}đ`)
          .join(', ');

        actions.push({
          id: st.id,
          type: 'STORE_ORDER',
          typeName: 'Gọi món bàn ăn',
          actionTitle: `Hóa đơn ${st.customer?.name || 'Bàn ăn'}: ${amountNum.toLocaleString('vi-VN')}đ`,
          actor,
          createdAt: st.createdAt,
          amount: amountNum,
          details: itemDetails + (st.note ? ` (Ghi chú: ${st.note})` : ''),
          rawItem: st,
          canEdit: true,
          canDelete: true,
        });
      }

      const storePayments = await prisma.payment.findMany({
        where: {
          customer: { userId: ownerId },
          type: 'store',
          createdBy: { in: targetUserIds },
          createdAt: { gte: startDate, lte: endDate },
        },
        include: {
          customer: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      for (const sp of storePayments) {
        const actor = memberUserMap.get(sp.createdBy) || { id: sp.createdBy, name: 'Nhân viên', phone: '' };
        const amountNum = parseFloat(sp.amount) || 0;
        actions.push({
          id: sp.id,
          type: 'STORE_PAYMENT',
          typeName: 'Thanh toán bàn ăn',
          actionTitle: `Thanh toán cho ${sp.customer?.name || 'Bàn'}: ${amountNum.toLocaleString('vi-VN')}đ`,
          actor,
          createdAt: sp.createdAt,
          amount: amountNum,
          details: `Thanh toán thành công ${amountNum.toLocaleString('vi-VN')}đ` + (sp.note ? ` (Ghi chú: ${sp.note})` : ''),
          rawItem: sp,
          canEdit: true,
          canDelete: true,
        });
      }
    }

    // 5. Cửa hàng tính giờ / Bida / Karaoke (Shop Sessions)
    const shouldFetchShop = !type || type === 'ALL' || type === 'SHOP';
    if (shouldFetchShop) {
      const shopSessions = await prisma.shopSession.findMany({
        where: {
          userId: ownerId,
          createdBy: { in: targetUserIds },
          createdAt: { gte: startDate, lte: endDate },
        },
        include: {
          table: { select: { id: true, name: true, pricePerHour: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      for (const ss of shopSessions) {
        const actor = memberUserMap.get(ss.createdBy) || { id: ss.createdBy, name: 'Nhân viên', phone: '' };
        const amountNum = ss.totalAmount || 0;
        const isEnded = !!ss.endTime;

        actions.push({
          id: ss.id,
          type: 'SHOP_SESSION',
          typeName: 'Phiên tính giờ',
          actionTitle: `${ss.table?.name || 'Bàn/Phòng'}: ${isEnded ? (ss.isPaid ? 'Đã thanh toán ' + amountNum.toLocaleString('vi-VN') + 'đ' : 'Chờ thanh toán ' + amountNum.toLocaleString('vi-VN') + 'đ') : 'Đang chơi'}`,
          actor,
          createdAt: ss.createdAt,
          amount: amountNum,
          details: `Bắt đầu: ${new Date(ss.startTime).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}` + (isEnded ? ` - Kết thúc: ${new Date(ss.endTime).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}` : '') + (ss.extraAmount ? ` | Phụ thu: ${ss.extraAmount.toLocaleString('vi-VN')}đ` : ''),
          rawItem: ss,
          canEdit: true,
          canDelete: true,
        });
      }
    }

    // 6. Kho hàng (Inventory Products)
    const shouldFetchInventory = !type || type === 'ALL' || type === 'INVENTORY';
    if (shouldFetchInventory) {
      const inventoryProducts = await prisma.inventoryProduct.findMany({
        where: {
          userId: ownerId,
          createdBy: { in: targetUserIds },
          createdAt: { gte: startDate, lte: endDate },
        },
        orderBy: { createdAt: 'desc' },
      });

      for (const ip of inventoryProducts) {
        const actor = memberUserMap.get(ip.createdBy) || { id: ip.createdBy, name: 'Nhân viên', phone: '' };
        actions.push({
          id: ip.id,
          type: 'INVENTORY',
          typeName: 'Kho hàng',
          actionTitle: `Thêm mặt hàng kho: ${ip.name}`,
          actor,
          createdAt: ip.createdAt,
          amount: parseFloat(ip.price) || 0,
          details: `Tồn kho: ${parseFloat(ip.quantity)} ${ip.unit} | Giá nhập: ${parseFloat(ip.price).toLocaleString('vi-VN')}đ`,
          rawItem: ip,
          canEdit: true,
          canDelete: true,
        });
      }
    }

    // 7. Nhà cung cấp (Supplier Transactions & Payments)
    const shouldFetchSuppliers = !type || type === 'ALL' || type === 'SUPPLIER';
    if (shouldFetchSuppliers) {
      const supplierTxs = await prisma.supplierTransaction.findMany({
        where: {
          supplier: { userId: ownerId },
          createdBy: { in: targetUserIds },
          createdAt: { gte: startDate, lte: endDate },
        },
        include: {
          supplier: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      for (const stx of supplierTxs) {
        const actor = memberUserMap.get(stx.createdBy) || { id: stx.createdBy, name: 'Nhân viên', phone: '' };
        const amountNum = parseFloat(stx.totalAmount) || 0;
        actions.push({
          id: stx.id,
          type: 'SUPPLIER_TX',
          typeName: 'Nhập hàng NCC',
          actionTitle: `Nhập hàng từ NCC ${stx.supplier?.name || 'Ẩn'}: ${amountNum.toLocaleString('vi-VN')}đ`,
          actor,
          createdAt: stx.createdAt,
          amount: amountNum,
          details: `Số tiền ghi nợ NCC: ${amountNum.toLocaleString('vi-VN')}đ` + (stx.note ? ` (Ghi chú: ${stx.note})` : ''),
          rawItem: stx,
          canEdit: true,
          canDelete: true,
        });
      }

      const supplierPayments = await prisma.supplierPayment.findMany({
        where: {
          supplier: { userId: ownerId },
          createdBy: { in: targetUserIds },
          createdAt: { gte: startDate, lte: endDate },
        },
        include: {
          supplier: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      for (const spay of supplierPayments) {
        const actor = memberUserMap.get(spay.createdBy) || { id: spay.createdBy, name: 'Nhân viên', phone: '' };
        const amountNum = parseFloat(spay.amount) || 0;
        actions.push({
          id: spay.id,
          type: 'SUPPLIER_PAYMENT',
          typeName: 'Trả tiền NCC',
          actionTitle: `Thanh toán nợ cho NCC ${spay.supplier?.name || 'Ẩn'}: ${amountNum.toLocaleString('vi-VN')}đ`,
          actor,
          createdAt: spay.createdAt,
          amount: amountNum,
          details: `Đã trả NCC: ${amountNum.toLocaleString('vi-VN')}đ` + (spay.note ? ` (Ghi chú: ${spay.note})` : ''),
          rawItem: spay,
          canEdit: true,
          canDelete: true,
        });
      }
    }

    // Sắp xếp toàn bộ thao tác theo thời gian giảm dần (mới nhất lên đầu)
    actions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.status(200).json({
      success: true,
      data: {
        summary: {
          totalActions: actions.length,
          totalDebtCreated,
          totalMoneyCollected,
        },
        members: memberUsers,
        actions,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createWorkspace,
  getMyWorkspace,
  getPendingRequests,
  joinWorkspace,
  getJoinStatus,
  approveJoinRequest,
  rejectJoinRequest,
  updateMemberPermissions,
  kickMember,
  leaveWorkspace,
  updateWorkspace,
  getMemberActions,
};


