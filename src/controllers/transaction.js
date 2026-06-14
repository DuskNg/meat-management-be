// meat-management-be/src/controllers/transaction.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError } = require('../utils/errors');

// 1. Tạo đơn hàng ghi nợ mới (Transaction)
const createTransaction = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { customerId, date, note, items } = req.body;

    if (!customerId || !items || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestError('Khách hàng và danh sách mặt hàng thịt mua là bắt buộc.');
    }

    // Kiểm tra khách hàng có tồn tại và thuộc chủ buôn này không
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, userId, isActive: true },
    });
    if (!customer) {
      throw new NotFoundError('Khách hàng không tồn tại hoặc không thuộc quyền quản lý của bạn.');
    }

    // Lấy toàn bộ sản phẩm thịt liên quan để xác thực
    const productIds = items.map((i) => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, userId, isActive: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    // Kiểm tra tính hợp lệ và tính tổng tiền của từng dòng mặt hàng
    let calculatedTotal = 0;
    const formattedItems = [];

    for (const item of items) {
      if (!item.productId || item.quantity === undefined || item.price === undefined) {
        throw new BadRequestError('Mỗi dòng mặt hàng phải chứa thông tin sản phẩm, số lượng và giá bán.');
      }

      const product = productMap.get(item.productId);
      if (!product) {
        throw new NotFoundError(`Sản phẩm thịt với ID ${item.productId} không tồn tại hoặc đã bị ẩn.`);
      }

      const quantity = parseFloat(item.quantity);
      const price = parseFloat(item.price);
      if (quantity <= 0 || price < 0) {
        throw new BadRequestError('Số lượng thịt phải lớn hơn 0 và đơn giá không được âm.');
      }

      const amount = quantity * price;
      calculatedTotal += amount;

      formattedItems.push({
        productId: item.productId,
        quantity,
        price,
        amount,
      });
    }

    // Thực hiện lưu giao dịch và các chi tiết dòng vào database sử dụng Prisma Transaction
    const newTransaction = await prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.create({
        data: {
          userId,
          customerId,
          date: date ? new Date(date) : new Date(),
          note: note || null,
          totalAmount: calculatedTotal,
          items: {
            create: formattedItems,
          },
        },
        include: {
          items: {
            include: {
              product: {
                select: {
                  name: true,
                  unit: true,
                },
              },
            },
          },
        },
      });
      return transaction;
    });

    res.status(201).json({
      success: true,
      data: newTransaction,
    });
  } catch (error) {
    next(error);
  }
};

// 2. Lấy danh sách hóa đơn giao dịch (có thể lọc theo khách hàng)
const getTransactions = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { customerId } = req.query;

    const whereClause = { userId };
    if (customerId) {
      whereClause.customerId = customerId;
    }

    const transactions = await prisma.transaction.findMany({
      where: whereClause,
      include: {
        customer: {
          select: {
            name: true,
            phone: true,
          },
        },
        items: {
          include: {
            product: {
              select: {
                name: true,
                unit: true,
              },
            },
          },
        },
      },
      orderBy: {
        date: 'desc', // Đơn hàng mới nhất hiển thị lên đầu
      },
    });

    res.status(200).json({
      success: true,
      data: transactions,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createTransaction,
  getTransactions,
};
