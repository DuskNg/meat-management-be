// meat-management-be/src/controllers/payment.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');

// 1. Tạo nhật ký thu tiền trả nợ mới (Payment)
const createPayment = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { customerId, amount, paidAt, note } = req.body;

    if (!customerId || amount === undefined) {
      throw new BadRequestError('Khách hàng và số tiền thanh toán là bắt buộc.');
    }

    const payAmount = parseFloat(amount);
    if (payAmount <= 0) {
      throw new BadRequestError('Số tiền thanh toán phải lớn hơn 0.');
    }

    // Kiểm tra khách hàng có tồn tại và thuộc quyền quản lý của chủ buôn hay không
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, userId, isActive: true },
    });
    if (!customer) {
      throw new NotFoundError('Khách hàng không tồn tại hoặc không thuộc quyền quản lý của bạn.');
    }

    // Lưu lượt trả nợ vào database
    const payment = await prisma.payment.create({
      data: {
        customerId,
        createdBy: req.user.id,
        amount: payAmount,
        paidAt: paidAt ? new Date(paidAt) : new Date(),
        note: note || null,
      },
      include: {
        customer: {
          select: {
            name: true,
            phone: true,
          },
        },
      },
    });

    await logActivity(
      userId,
      'CREATE_PAYMENT',
      `Thu tiền trả nợ từ khách hàng ${customer.name}: Số tiền ${payAmount.toLocaleString('vi-VN')}đ`
    );

    res.status(201).json({
      success: true,
      data: payment,
    });
  } catch (error) {
    next(error);
  }
};

// 2. Lấy danh sách nhật ký trả nợ (có thể lọc theo khách hàng)
const getPayments = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { customerId } = req.query;

    // Lọc theo khách hàng thuộc chủ buôn này
    const whereClause = {
      customer: {
        userId,
      },
    };
    if (customerId) {
      whereClause.customerId = customerId;
    }

    const payments = await prisma.payment.findMany({
      where: whereClause,
      include: {
        customer: {
          select: {
            name: true,
            phone: true,
          },
        },
      },
      orderBy: {
        paidAt: 'desc', // Lượt trả nợ mới nhất xếp trên đầu
      },
    });

    res.status(200).json({
      success: true,
      data: payments,
    });
  } catch (error) {
    next(error);
  }
};

// 3. Cập nhật lượt thu tiền (số tiền, ngày, ghi chú)
const updatePayment = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;
    const { amount, paidAt, note } = req.body;

    // Kiểm tra payment tồn tại và thuộc khach hàng của chủ buôn này
    const existing = await prisma.payment.findFirst({
      where: { id, customer: { userId } },
    });
    if (!existing) {
      throw new NotFoundError('Lượt thu tiền không tồn tại hoặc không thuộc quyền quản lý.');
    }

    // Xác thực số tiền nếu có cung cấp
    let payAmount = existing.amount;
    if (amount !== undefined) {
      payAmount = parseFloat(amount);
      if (payAmount <= 0) throw new BadRequestError('Số tiền phải lớn hơn 0.');
    }

    const updated = await prisma.payment.update({
      where: { id },
      data: {
        amount: payAmount,
        paidAt: paidAt ? new Date(paidAt) : existing.paidAt,
        note: note !== undefined ? (note || null) : existing.note,
      },
      include: { customer: { select: { name: true, phone: true } } },
    });

    await logActivity(
      userId,
      'UPDATE_PAYMENT',
      `Cập nhật lượt thu tiền của khách hàng ${updated.customer.name}: Số tiền mới ${payAmount.toLocaleString('vi-VN')}đ`
    );

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

// 4. Xóa lượt thu tiền trả nợ (Payment) theo ID
const deletePayment = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;

    // Kiểm tra payment tồn tại và thuộc khách hàng của chủ buôn này
    const existing = await prisma.payment.findFirst({
      where: { id, customer: { userId } },
    });
    if (!existing) {
      throw new NotFoundError('Lượt thu tiền không tồn tại hoặc không thuộc quyền quản lý của bạn.');
    }

    // Kiểm tra bảo vệ dữ liệu chéo: Nhân viên chỉ được xóa dữ liệu do chính mình tạo. Chủ Workspace và Admin tối cao có toàn quyền.
    const actorId = req.user.id;
    const actorIsAdmin = req.user.isAdmin === true;
    if (!actorIsAdmin && existing.createdBy !== actorId && actorId !== userId) {
      throw new ForbiddenError('Tài khoản của bạn không có quyền xóa dữ liệu do người khác tạo.');
    }

    // Thực hiện xóa lượt trả nợ
    await prisma.payment.delete({
      where: { id },
    });

    const customer = await prisma.customer.findUnique({
      where: { id: existing.customerId }
    });

    await logActivity(
      userId,
      'DELETE_PAYMENT',
      `Xóa lượt thu tiền của khách hàng ${customer?.name || 'ẩn'}: Số tiền ${existing.amount.toLocaleString('vi-VN')}đ`
    );

    res.status(200).json({
      success: true,
      message: 'Xóa lượt thu tiền thành công.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createPayment,
  getPayments,
  updatePayment,
  deletePayment,
};
