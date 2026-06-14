// meat-management-be/src/controllers/payment.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError } = require('../utils/errors');

// 1. Tạo nhật ký thu tiền trả nợ mới (Payment)
const createPayment = async (req, res, next) => {
  try {
    const userId = req.user.id;
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
    const userId = req.user.id;
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

module.exports = {
  createPayment,
  getPayments,
};
