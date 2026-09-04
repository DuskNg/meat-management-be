// meat-management-be/src/controllers/recurringDebt.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');
const { emitWorkspaceEvent } = require('../utils/socket');

// Helper gửi socket event thông báo danh sách đơn nợ cố định thay đổi
const notifyRecurringDebtUpdate = (userId, action, payload = {}) => {
  emitWorkspaceEvent(userId, 'RECURRING_DEBT_UPDATED', {
    action,
    userId,
    timestamp: new Date().toISOString(),
    ...payload,
  });
};

// 1. Lấy danh sách các đơn nợ cố định hàng ngày
const getRecurringDebts = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;

    const recurringDebts = await prisma.recurringDebt.findMany({
      where: {
        userId,
        isActive: true,
      },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
            isActive: true,
            isBadDebt: true,
          },
        },
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                unit: true,
                defaultPrice: true,
                costPrice: true,
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.status(200).json({
      success: true,
      data: recurringDebts,
    });
  } catch (error) {
    next(error);
  }
};

// 2. Tạo đơn nợ cố định hàng ngày mới
const createRecurringDebt = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { customerId, note, items, profitPercent } = req.body;

    if (!customerId) {
      throw new BadRequestError('Mã khách hàng là bắt buộc.');
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestError('Đơn nợ cố định phải có ít nhất một dòng mặt hàng.');
    }

    // Kiểm tra khách hàng có tồn tại và thuộc chủ buôn này không
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, userId, isActive: true },
    });

    if (!customer) {
      throw new NotFoundError('Khách hàng không tồn tại hoặc không thuộc quyền quản lý của bạn.');
    }

    // Lấy danh sách toàn bộ sản phẩm của chủ buôn
    const allUserProducts = await prisma.product.findMany({
      where: { userId, isActive: true },
    });
    const productMap = new Map(allUserProducts.map((p) => [p.id, p]));

    let calculatedTotal = 0;
    let calculatedTotalCost = 0;
    let calculatedTotalProfit = 0;
    const formattedItems = [];

    for (const item of items) {
      const { productId, quantity: reqQuantity, price: reqPrice, costPrice: reqCostPrice, productName, unit } = item;
      let finalProductId = productId;

      // Xử lý tạo sản phẩm nhanh nếu chưa có
      if (!finalProductId && productName) {
        let existingProd = allUserProducts.find((p) => p.name.trim().toLowerCase() === productName.trim().toLowerCase());
        if (!existingProd) {
          existingProd = await prisma.product.create({
            data: {
              userId,
              createdBy: req.user.id,
              name: productName.trim(),
              defaultPrice: parseFloat(reqPrice) || 0,
              costPrice: reqCostPrice !== undefined ? parseFloat(reqCostPrice) : 0,
              unit: unit || 'kg',
            },
          });
          allUserProducts.push(existingProd);
          productMap.set(existingProd.id, existingProd);
        }
        finalProductId = existingProd.id;
      }

      let product = productMap.get(finalProductId);
      if (!product) {
        product = allUserProducts.find((p) => p.id === finalProductId);
      }

      if (!product) {
        throw new NotFoundError(`Sản phẩm thịt không tồn tại hoặc đã bị ẩn.`);
      }

      const quantity = parseFloat(reqQuantity);
      const price = parseFloat(reqPrice);
      const costPrice = reqCostPrice !== undefined ? parseFloat(reqCostPrice) : (parseFloat(product.costPrice) || 0);

      if (quantity <= 0 || price < 0) {
        throw new BadRequestError('Số lượng thịt phải lớn hơn 0 và đơn giá không được âm.');
      }

      const amount = Math.round(quantity * price);
      const itemCost = Math.round(quantity * costPrice);
      const itemProfit = amount - itemCost;

      calculatedTotal += amount;
      calculatedTotalCost += itemCost;
      calculatedTotalProfit += itemProfit;

      formattedItems.push({
        productId: finalProductId,
        quantity,
        price,
        costPrice,
        amount,
        profit: itemProfit,
      });
    }

    // Xử lý % lợi nhuận nếu người dùng nhập riêng (cho ghi nợ nhanh)
    let finalProfitPercent = profitPercent !== undefined && profitPercent !== null && profitPercent !== '' ? parseFloat(profitPercent) : null;
    let finalTotalCost = calculatedTotalCost;
    let finalTotalProfit = calculatedTotalProfit;

    if (finalProfitPercent !== null && !isNaN(finalProfitPercent)) {
      finalTotalProfit = Math.round(calculatedTotal * (finalProfitPercent / 100));
      finalTotalCost = calculatedTotal - finalTotalProfit;
      if (formattedItems.length === 1) {
        formattedItems[0].profit = finalTotalProfit;
        formattedItems[0].costPrice = Math.round(finalTotalCost / formattedItems[0].quantity);
      }
    }

    // Lưu vào database
    const newRecurringDebt = await prisma.recurringDebt.create({
      data: {
        userId,
        createdBy: req.user.id,
        customerId,
        note: note || null,
        totalAmount: calculatedTotal,
        profitPercent: finalProfitPercent,
        totalCost: finalTotalCost,
        totalProfit: finalTotalProfit,
        isActive: true,
        items: {
          create: formattedItems,
        },
      },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                unit: true,
                defaultPrice: true,
                costPrice: true,
              },
            },
          },
        },
      },
    });

    await logActivity(
      userId,
      'CREATE_RECURRING_DEBT',
      `Tạo mẫu đơn nợ cố định hàng ngày cho khách hàng ${customer.name}: ${calculatedTotal.toLocaleString('vi-VN')}đ`
    );
    notifyRecurringDebtUpdate(userId, 'CREATE_RECURRING_DEBT', { recurringDebtId: newRecurringDebt.id });

    res.status(201).json({
      success: true,
      message: 'Tạo đơn nợ cố định hàng ngày thành công.',
      data: newRecurringDebt,
    });
  } catch (error) {
    next(error);
  }
};

// 3. Cập nhật đơn nợ cố định hàng ngày
const updateRecurringDebt = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;
    const { customerId, note, items, profitPercent } = req.body;

    const existingDebt = await prisma.recurringDebt.findFirst({
      where: { id, userId },
      include: { items: true },
    });

    if (!existingDebt) {
      throw new NotFoundError('Đơn nợ cố định không tồn tại hoặc không thuộc quyền quản lý của bạn.');
    }

    const targetCustomerId = customerId || existingDebt.customerId;
    const customer = await prisma.customer.findFirst({
      where: { id: targetCustomerId, userId, isActive: true },
    });

    if (!customer) {
      throw new NotFoundError('Khách hàng không tồn tại hoặc không thuộc quyền quản lý của bạn.');
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestError('Đơn nợ cố định phải có ít nhất một dòng mặt hàng.');
    }

    const allUserProducts = await prisma.product.findMany({
      where: { userId, isActive: true },
    });
    const productMap = new Map(allUserProducts.map((p) => [p.id, p]));

    let calculatedTotal = 0;
    let calculatedTotalCost = 0;
    let calculatedTotalProfit = 0;
    const formattedItems = [];

    for (const item of items) {
      const { productId, quantity: reqQuantity, price: reqPrice, costPrice: reqCostPrice, productName, unit } = item;
      let finalProductId = productId;

      if (!finalProductId && productName) {
        let existingProd = allUserProducts.find((p) => p.name.trim().toLowerCase() === productName.trim().toLowerCase());
        if (!existingProd) {
          existingProd = await prisma.product.create({
            data: {
              userId,
              createdBy: req.user.id,
              name: productName.trim(),
              defaultPrice: parseFloat(reqPrice) || 0,
              costPrice: reqCostPrice !== undefined ? parseFloat(reqCostPrice) : 0,
              unit: unit || 'kg',
            },
          });
          allUserProducts.push(existingProd);
          productMap.set(existingProd.id, existingProd);
        }
        finalProductId = existingProd.id;
      }

      let product = productMap.get(finalProductId);
      if (!product) {
        product = allUserProducts.find((p) => p.id === finalProductId);
      }

      if (!product) {
        throw new NotFoundError(`Sản phẩm thịt không tồn tại hoặc đã bị ẩn.`);
      }

      const quantity = parseFloat(reqQuantity);
      const price = parseFloat(reqPrice);
      const costPrice = reqCostPrice !== undefined ? parseFloat(reqCostPrice) : (parseFloat(product.costPrice) || 0);

      if (quantity <= 0 || price < 0) {
        throw new BadRequestError('Số lượng thịt phải lớn hơn 0 và đơn giá không được âm.');
      }

      const amount = Math.round(quantity * price);
      const itemCost = Math.round(quantity * costPrice);
      const itemProfit = amount - itemCost;

      calculatedTotal += amount;
      calculatedTotalCost += itemCost;
      calculatedTotalProfit += itemProfit;

      formattedItems.push({
        productId: finalProductId,
        quantity,
        price,
        costPrice,
        amount,
        profit: itemProfit,
      });
    }

    let finalProfitPercent = profitPercent !== undefined && profitPercent !== null && profitPercent !== '' ? parseFloat(profitPercent) : null;
    let finalTotalCost = calculatedTotalCost;
    let finalTotalProfit = calculatedTotalProfit;

    if (finalProfitPercent !== null && !isNaN(finalProfitPercent)) {
      finalTotalProfit = Math.round(calculatedTotal * (finalProfitPercent / 100));
      finalTotalCost = calculatedTotal - finalTotalProfit;
      if (formattedItems.length === 1) {
        formattedItems[0].profit = finalTotalProfit;
        formattedItems[0].costPrice = Math.round(finalTotalCost / formattedItems[0].quantity);
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Xóa các item cũ
      await tx.recurringDebtItem.deleteMany({
        where: { recurringDebtId: id },
      });

      return tx.recurringDebt.update({
        where: { id },
        data: {
          customerId: targetCustomerId,
          note: note !== undefined ? note : existingDebt.note,
          totalAmount: calculatedTotal,
          profitPercent: finalProfitPercent,
          totalCost: finalTotalCost,
          totalProfit: finalTotalProfit,
          items: {
            create: formattedItems,
          },
        },
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              phone: true,
            },
          },
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  unit: true,
                  defaultPrice: true,
                  costPrice: true,
                },
              },
            },
          },
        },
      });
    });

    await logActivity(
      userId,
      'UPDATE_RECURRING_DEBT',
      `Cập nhật mẫu đơn nợ cố định của khách hàng ${customer.name}: ${calculatedTotal.toLocaleString('vi-VN')}đ`
    );
    notifyRecurringDebtUpdate(userId, 'UPDATE_RECURRING_DEBT', { recurringDebtId: id });

    res.status(200).json({
      success: true,
      message: 'Cập nhật đơn nợ cố định thành công.',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

// 4. Xóa đơn nợ cố định (Khi xóa thì các ngày sau sẽ không còn tự động thêm đơn này nữa)
const deleteRecurringDebt = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;

    const existingDebt = await prisma.recurringDebt.findFirst({
      where: { id, userId },
      include: { customer: true },
    });

    if (!existingDebt) {
      throw new NotFoundError('Đơn nợ cố định không tồn tại hoặc không thuộc quyền quản lý của bạn.');
    }

    await prisma.recurringDebt.delete({
      where: { id },
    });

    await logActivity(
      userId,
      'DELETE_RECURRING_DEBT',
      `Xóa mẫu đơn nợ cố định hàng ngày của khách hàng ${existingDebt.customer?.name || 'Khách hàng'}`
    );
    notifyRecurringDebtUpdate(userId, 'DELETE_RECURRING_DEBT', { recurringDebtId: id });

    res.status(200).json({
      success: true,
      message: 'Đã xóa đơn nợ cố định. Kể từ ngày mai đơn này sẽ không được tự động thêm.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getRecurringDebts,
  createRecurringDebt,
  updateRecurringDebt,
  deleteRecurringDebt,
};
