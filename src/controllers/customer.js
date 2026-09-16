// meat-management-be/src/controllers/customer.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');
const { emitWorkspaceEvent } = require('../utils/socket');

// Helper gửi socket event thông báo khách hàng thay đổi
const notifyCustomerUpdate = (userId, action, payload = {}) => {
  emitWorkspaceEvent(userId, 'CUSTOMER_UPDATED', {
    action,
    userId,
    timestamp: new Date().toISOString(),
    ...payload,
  });
};

// 1. Lấy toàn bộ danh sách khách hàng của chủ buôn đang đăng nhập
const getCustomers = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { isBadDebt, month } = req.query;

    // Xử lý bộ lọc theo tháng nếu có truyền (định dạng MM/YYYY hoặc YYYY-MM)
    let targetMonth = null;
    let targetYear = null;
    let startOfMonth = null;
    let endOfMonth = null;

    if (month && String(month).trim() !== '' && String(month).trim().toLowerCase() !== 'all') {
      const mStr = String(month).trim();
      if (mStr.includes('/')) {
        const parts = mStr.split('/');
        targetMonth = parseInt(parts[0], 10);
        targetYear = parseInt(parts[1], 10);
      } else if (mStr.includes('-')) {
        const parts = mStr.split('-');
        targetYear = parseInt(parts[0], 10);
        targetMonth = parseInt(parts[1], 10);
      }
      if (targetMonth && targetYear && !isNaN(targetMonth) && !isNaN(targetYear)) {
        // Khung thời gian theo múi giờ Việt Nam (UTC+7)
        startOfMonth = new Date(Date.UTC(targetYear, targetMonth - 1, 1, -7, 0, 0, 0));
        endOfMonth = new Date(Date.UTC(targetYear, targetMonth, 0, 16, 59, 59, 999));
      }
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundError('Không tìm thấy tài khoản người dùng.');
    }

    // Kiểm tra quyền
    if (!user.isAdmin) {
      if (isBadDebt === 'true') {
        if (!user.canManageBadDebt) {
          throw new ForbiddenError('Tài khoản của bạn không được cấp quyền quản lý nợ xấu.');
        }
      } else {
        if (!user.canManageCustomers) {
          throw new ForbiddenError('Tài khoản của bạn không được cấp quyền quản lý khách hàng.');
        }
      }
    }

    const whereFilter = {
      userId,
      isActive: true, // Chỉ lấy những khách hàng đang hoạt động (chưa bị xóa mềm)
    };

    if (isBadDebt !== undefined) {
      whereFilter.isBadDebt = isBadDebt === 'true';
    } else {
      whereFilter.isBadDebt = false; // Mặc định chỉ lấy khách hàng hoạt động bình thường
    }

    const customers = await prisma.customer.findMany({
      where: whereFilter,
      include: {
        transactions: {
          select: {
            totalAmount: true,
            date: true,
          },
        },
        payments: {
          select: {
            amount: true,
            paidAt: true,
            note: true,
          },
        },
      },
      orderBy: {
        name: 'asc', // Sắp xếp theo thứ tự bảng chữ cái tên khách hàng
      },
    });

    // Tính toán công nợ thực tế cho từng khách hàng (làm tròn số nguyên chuẩn VNĐ)
    const dataWithDebt = customers.map((c) => {
      const totalPurchase = Math.round(c.transactions.reduce((sum, t) => sum + parseFloat(t.totalAmount || 0), 0));
      const totalPaid = Math.round(c.payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0));
      // Bao gồm cả manualDebt (số nợ thủ công ban đầu cho khách nợ xấu không có lịch sử giao dịch)
      let debt = Math.round(totalPurchase - totalPaid + parseFloat(c.manualDebt || 0));
      if (Math.abs(debt) < 1) {
        debt = 0;
      }

      let monthDebt = debt;
      let monthPurchase = totalPurchase;
      let monthPaid = totalPaid;

      // Nếu có yêu cầu lọc nợ theo tháng mục tiêu cụ thể
      if (targetMonth && targetYear && startOfMonth && endOfMonth) {
        // Tiền hàng phát sinh trong tháng
        const monthTx = c.transactions.filter((t) => {
          if (!t.date) return false;
          const d = new Date(t.date);
          return d >= startOfMonth && d <= endOfMonth;
        });
        monthPurchase = Math.round(monthTx.reduce((sum, t) => sum + parseFloat(t.totalAmount || 0), 0));

        // Tiền đã thanh toán được ghi nhận cho tháng đó (theo ghi chú hoặc ngày thanh toán)
        let paidForMonth = 0;
        for (const pm of c.payments) {
          const amt = parseFloat(pm.amount) || 0;
          const note = (pm.note || '').trim();
          const monthMatch = note.match(/Thanh toán (?:nợ|hóa đơn)?\s*[Tt]háng (\d{2})\/(\d{4})/i);

          if (monthMatch) {
            const pM = parseInt(monthMatch[1], 10);
            const pY = parseInt(monthMatch[2], 10);
            if (pM === targetMonth && pY === targetYear) {
              paidForMonth += amt;
            }
          } else if (pm.paidAt) {
            const pDate = new Date(pm.paidAt);
            if (pDate >= startOfMonth && pDate <= endOfMonth) {
              paidForMonth += amt;
            }
          }
        }
        monthPaid = Math.round(paidForMonth);

        // Công nợ tháng = Mua trong tháng - Đã trả cho tháng
        let rawMonthDebt = Math.round(monthPurchase - monthPaid);
        if (rawMonthDebt < 0) rawMonthDebt = 0;
        // Nợ tháng không vượt quá tổng nợ tích lũy thực tế của khách hàng
        monthDebt = Math.min(rawMonthDebt, Math.max(0, debt));
      }

      // Loại bỏ danh sách giao dịch con để giảm tải dung lượng mạng
      const { transactions, payments, ...rest } = c;
      return {
        ...rest,
        debt,
        monthDebt,
        monthPurchase,
        monthPaid,
      };
    });

    res.status(200).json({
      success: true,
      data: dataWithDebt,
    });
  } catch (error) {
    next(error);
  }
};

// 2. Lấy chi tiết khách hàng theo ID
const getCustomerById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.effectiveUserId;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundError('Không tìm thấy tài khoản người dùng.');
    }

    const customer = await prisma.customer.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
      include: {
        transactions: {
          select: {
            totalAmount: true,
          },
        },
        payments: {
          select: {
            amount: true,
          },
        },
      },
    });

    if (!customer) {
      throw new NotFoundError('Không tìm thấy khách hàng hoặc bạn không có quyền truy cập.');
    }

    // Kiểm tra quyền
    if (!user.isAdmin) {
      if (customer.isBadDebt) {
        if (!user.canManageBadDebt) {
          throw new ForbiddenError('Tài khoản của bạn không được cấp quyền quản lý nợ xấu.');
        }
      } else {
        if (!user.canManageCustomers) {
          throw new ForbiddenError('Tài khoản của bạn không được cấp quyền quản lý khách hàng.');
        }
      }
    }

    const totalPurchase = Math.round(customer.transactions.reduce((sum, t) => sum + parseFloat(t.totalAmount || 0), 0));
    const totalPaid = Math.round(customer.payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0));
    // Bao gồm cả manualDebt (số nợ thủ công ban đầu cho khách nợ xấu không có lịch sử giao dịch)
    let debt = Math.round(totalPurchase - totalPaid + parseFloat(customer.manualDebt || 0));
    if (Math.abs(debt) < 1) {
      debt = 0;
    }

    const { transactions, payments, ...rest } = customer;

    res.status(200).json({
      success: true,
      data: {
        ...rest,
        debt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 3. Tạo mới khách hàng
const createCustomer = async (req, res, next) => {
  try {
    const { name, phone, address, note, isBadDebt, manualDebt } = req.body;
    const userId = req.effectiveUserId;

    if (!name || name.trim() === '') {
      throw new BadRequestError('Tên khách hàng là thông tin bắt buộc.');
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundError('Không tìm thấy tài khoản người dùng.');
    }

    const isBadDebtBool = isBadDebt === true || isBadDebt === 'true';

    // Kiểm tra quyền
    if (!user.isAdmin) {
      if (isBadDebtBool) {
        if (!user.canManageBadDebt) {
          throw new ForbiddenError('Tài khoản của bạn không được cấp quyền quản lý nợ xấu.');
        }
      } else {
        if (!user.canManageCustomers) {
          throw new ForbiddenError('Tài khoản của bạn không được cấp quyền quản lý khách hàng.');
        }
      }
    }

    // Validate số tiền nợ ban đầu (nếu có)
    if (manualDebt !== undefined && manualDebt !== null && manualDebt !== '') {
      const debtNum = parseFloat(manualDebt);
      if (isNaN(debtNum) || debtNum < 0) {
        throw new BadRequestError('Số tiền nợ không hợp lệ. Vui lòng nhập số dương.');
      }
    }

    const trimmedName = name.trim();

    // Kiểm tra trùng tên khách hàng (chỉ tính những khách hàng đang hoạt động)
    const existingName = await prisma.customer.findFirst({
      where: {
        userId,
        name: trimmedName,
        isActive: true,
      },
    });

    if (existingName) {
      throw new BadRequestError('Tên khách hàng này đã tồn tại trong danh sách của bạn.');
    }

    // Kiểm tra trùng số điện thoại khách hàng (nếu có nhập)
    if (phone && phone.trim() !== '') {
      const trimmedPhone = phone.trim();
      const existingPhone = await prisma.customer.findFirst({
        where: {
          userId,
          phone: trimmedPhone,
          isActive: true,
        },
      });

      if (existingPhone) {
        throw new BadRequestError('Số điện thoại này đã được sử dụng cho một khách hàng khác của bạn.');
      }
    }

    const customer = await prisma.customer.create({
      data: {
        userId,
        createdBy: req.user.id,
        name: trimmedName,
        phone: phone ? phone.trim() : null,
        address: address ? address.trim() : null,
        note: note ? note.trim() : null,
        isBadDebt: isBadDebtBool,
        manualDebt: manualDebt ? parseFloat(manualDebt) : 0,
      },
    });

    // Ghi log hoạt động
    await logActivity(
      userId,
      isBadDebtBool ? 'CREATE_BAD_DEBT_CUSTOMER' : 'CREATE_CUSTOMER',
      `Tạo khách hàng mới: ${customer.name} (SĐT: ${customer.phone || 'Không'}, Nợ xấu: ${customer.isBadDebt})`
    );
    notifyCustomerUpdate(userId, 'CREATE_CUSTOMER', { customerId: customer.id });

    res.status(201).json({
      success: true,
      data: customer,
    });
  } catch (error) {
    next(error);
  }
};

// 4. Cập nhật thông tin khách hàng
const updateCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, phone, address, note, isBadDebt } = req.body;
    const userId = req.effectiveUserId;

    // Kiểm tra khách hàng có tồn tại và thuộc về chủ buôn này hay không
    const customerExists = await prisma.customer.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!customerExists) {
      throw new NotFoundError('Không tìm thấy khách hàng hoặc bạn không có quyền chỉnh sửa.');
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundError('Không tìm thấy tài khoản người dùng.');
    }

    // Kiểm tra quyền
    if (!user.isAdmin) {
      if (customerExists.isBadDebt || isBadDebt === true || isBadDebt === 'true') {
        if (!user.canManageBadDebt) {
          throw new ForbiddenError('Tài khoản của bạn không được cấp quyền quản lý nợ xấu.');
        }
      } else {
        if (!user.canManageCustomers) {
          throw new ForbiddenError('Tài khoản của bạn không được cấp quyền quản lý khách hàng.');
        }
      }
    }

    // Kiểm tra trùng tên khách hàng mới nếu có thay đổi tên
    if (name !== undefined) {
      if (!name || name.trim() === '') {
        throw new BadRequestError('Tên khách hàng là thông tin bắt buộc.');
      }
      const trimmedName = name.trim();
      const existingName = await prisma.customer.findFirst({
        where: {
          userId,
          name: trimmedName,
          isActive: true,
          NOT: { id },
        },
      });

      if (existingName) {
        throw new BadRequestError('Tên khách hàng này đã tồn tại trong danh sách của bạn.');
      }
    }

    // Kiểm tra trùng số điện thoại mới nếu có thay đổi số điện thoại
    if (phone !== undefined) {
      const trimmedPhone = phone ? phone.trim() : '';
      if (trimmedPhone !== '') {
        const existingPhone = await prisma.customer.findFirst({
          where: {
            userId,
            phone: trimmedPhone,
            isActive: true,
            NOT: { id },
          },
        });

        if (existingPhone) {
          throw new BadRequestError('Số điện thoại này đã được sử dụng cho một khách hàng khác của bạn.');
        }
      }
    }

    const updatedCustomer = await prisma.customer.update({
      where: { id },
      data: {
        name: name !== undefined ? name.trim() : undefined,
        phone: phone !== undefined ? (phone ? phone.trim() : null) : undefined,
        address: address !== undefined ? (address ? address.trim() : null) : undefined,
        note: note !== undefined ? (note ? note.trim() : null) : undefined,
        isBadDebt: isBadDebt !== undefined ? (isBadDebt === true || isBadDebt === 'true') : undefined,
      },
    });

    // Ghi log hoạt động
    const changes = [];
    if (customerExists.name !== updatedCustomer.name) {
      changes.push(`Tên: "${customerExists.name}" ➔ "${updatedCustomer.name}"`);
    }
    if ((customerExists.phone || '') !== (updatedCustomer.phone || '')) {
      changes.push(`SĐT: "${customerExists.phone || 'Không'}" ➔ "${updatedCustomer.phone || 'Không'}"`);
    }
    if ((customerExists.address || '') !== (updatedCustomer.address || '')) {
      changes.push(`Địa chỉ: "${customerExists.address || 'Không'}" ➔ "${updatedCustomer.address || 'Không'}"`);
    }
    if (customerExists.isBadDebt !== updatedCustomer.isBadDebt) {
      changes.push(`Nợ xấu: ${customerExists.isBadDebt ? 'Có' : 'Không'} ➔ ${updatedCustomer.isBadDebt ? 'Có' : 'Không'}`);
    }
    if ((customerExists.note || '') !== (updatedCustomer.note || '')) {
      changes.push(`Ghi chú: "${customerExists.note || 'Không'}" ➔ "${updatedCustomer.note || 'Không'}"`);
    }

    const logDetail = changes.length > 0
      ? `Cập nhật khách hàng "${customerExists.name}":\n• ${changes.join('\n• ')}`
      : `Cập nhật khách hàng "${customerExists.name}" (Không có thay đổi)`;

    await logActivity(
      userId,
      'UPDATE_CUSTOMER',
      logDetail
    );
    notifyCustomerUpdate(userId, 'UPDATE_CUSTOMER', { customerId: id });

    res.status(200).json({
      success: true,
      data: updatedCustomer,
    });
  } catch (error) {
    next(error);
  }
};

// 5. Xóa mềm khách hàng (Soft Delete)
const deleteCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.effectiveUserId;

    // Kiểm tra khách hàng có tồn tại và thuộc về chủ buôn này hay không
    const customerExists = await prisma.customer.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!customerExists) {
      throw new NotFoundError('Không tìm thấy khách hàng hoặc bạn không có quyền xóa.');
    }

    // Kiểm tra bảo vệ dữ liệu chéo: Nhân viên chỉ được xóa dữ liệu do chính mình tạo. Chủ Workspace và Admin tối cao có toàn quyền.
    const actorId = req.user.id;
    const actorIsAdmin = req.user.isAdmin === true;
    if (!actorIsAdmin && customerExists.createdBy !== actorId && actorId !== customerExists.userId) {
      throw new ForbiddenError('Tài khoản của bạn không có quyền xóa dữ liệu do người khác tạo.');
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundError('Không tìm thấy tài khoản người dùng.');
    }

    // Kiểm tra quyền
    if (!user.isAdmin) {
      if (customerExists.isBadDebt) {
        if (!user.canManageBadDebt) {
          throw new ForbiddenError('Tài khoản của bạn không được cấp quyền quản lý nợ xấu.');
        }
      } else {
        if (!user.canManageCustomers) {
          throw new ForbiddenError('Tài khoản của bạn không được cấp quyền quản lý khách hàng.');
        }
      }
    }

    // Thực hiện xóa mềm bằng cách cập nhật isActive = false
    await prisma.customer.update({
      where: { id },
      data: {
        isActive: false,
      },
    });

    // Ghi log hoạt động
    await logActivity(
      userId,
      'DELETE_CUSTOMER',
      `Xóa mềm khách hàng: ${customerExists.name} (SĐT: ${customerExists.phone || 'Không'}, Nợ xấu: ${customerExists.isBadDebt})`
    );
    notifyCustomerUpdate(userId, 'DELETE_CUSTOMER', { customerId: id });

    res.status(200).json({
      success: true,
      message: 'Đã xóa khách hàng thành công.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  deleteCustomer,
};
