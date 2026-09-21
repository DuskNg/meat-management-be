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

// Helper gửi socket event thông báo giao dịch / nợ khách hàng thay đổi
const notifyCustomerUpdate = (userId, action, payload = {}) => {
  emitWorkspaceEvent(userId, 'CUSTOMER_UPDATED', {
    action,
    userId,
    timestamp: new Date().toISOString(),
    ...payload,
  });
};

// Helper lấy ngày hiện tại theo múi giờ Việt Nam (UTC+7) dạng YYYY-MM-DD
const getVietnamDateKey = (date = new Date()) => {
  const vnTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const year = vnTime.getUTCFullYear();
  const month = String(vnTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(vnTime.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

    // Lưu vào database và đồng thời tạo ngay 1 giao dịch nợ cho ngày hôm nay
    const now = new Date();
    const { newRecurringDebt, createdTx } = await prisma.$transaction(async (tx) => {
      // 1. Tạo mẫu đơn nợ cố định (gắn lastGeneratedAt = now để 00:30 không bị sinh trùng lặp trong ngày hôm nay)
      const recDebt = await tx.recurringDebt.create({
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
          lastGeneratedAt: now,
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

      // 2. Tự động sinh ngay 1 đơn nợ thực tế vào bảng transactions cho ngày hôm nay
      const txItemsData = formattedItems.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        price: item.price,
        costPrice: item.costPrice,
        amount: item.amount,
        profit: item.profit,
      }));

      const transaction = await tx.transaction.create({
        data: {
          userId,
          createdBy: req.user.id,
          customerId,
          date: now,
          note: note || 'Đơn nợ cố định hàng ngày (Tự động thêm vào ngày hôm nay)',
          totalAmount: calculatedTotal,
          profitPercent: finalProfitPercent,
          totalCost: finalTotalCost,
          totalProfit: finalTotalProfit,
          type: 'customer',
          items: {
            create: txItemsData,
          },
        },
      });

      return { newRecurringDebt: recDebt, createdTx: transaction };
    });

    await logActivity(
      userId,
      'CREATE_RECURRING_DEBT',
      `Tạo mẫu đơn nợ cố định và tự động ghi nợ ngày hôm nay cho khách hàng ${customer.name}: ${calculatedTotal.toLocaleString('vi-VN')}đ`
    );
    notifyRecurringDebtUpdate(userId, 'CREATE_RECURRING_DEBT', { recurringDebtId: newRecurringDebt.id });
    notifyCustomerUpdate(userId, 'CREATE_TRANSACTION', {
      customerId,
      transactionId: createdTx.id,
    });

    res.status(201).json({
      success: true,
      message: 'Tạo đơn nợ cố định hàng ngày thành công và đã tự động lên đơn cho ngày hôm nay.',
      data: newRecurringDebt,
      transaction: createdTx,
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
      include: {
        customer: { select: { name: true } },
        items: {
          include: {
            product: { select: { name: true, unit: true } },
          },
        },
      },
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

    const now = new Date();
    const todayKey = getVietnamDateKey(now);
    const lastGenKey = existingDebt.lastGeneratedAt ? getVietnamDateKey(new Date(existingDebt.lastGeneratedAt)) : null;
    const shouldGenerateToday = lastGenKey !== todayKey;

    const { updated, createdTx } = await prisma.$transaction(async (tx) => {
      // Xóa các item cũ
      await tx.recurringDebtItem.deleteMany({
        where: { recurringDebtId: id },
      });

      const updatedDebt = await tx.recurringDebt.update({
        where: { id },
        data: {
          customerId: targetCustomerId,
          note: note !== undefined ? note : existingDebt.note,
          totalAmount: calculatedTotal,
          profitPercent: finalProfitPercent,
          totalCost: finalTotalCost,
          totalProfit: finalTotalProfit,
          ...(shouldGenerateToday ? { lastGeneratedAt: now } : {}),
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

      let newTx = null;
      if (shouldGenerateToday) {
        const txItemsData = formattedItems.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          price: item.price,
          costPrice: item.costPrice,
          amount: item.amount,
          profit: item.profit,
        }));

        newTx = await tx.transaction.create({
          data: {
            userId,
            createdBy: req.user.id,
            customerId: targetCustomerId,
            date: now,
            note: note || 'Đơn nợ cố định hàng ngày (Tự động thêm vào ngày hôm nay)',
            totalAmount: calculatedTotal,
            profitPercent: finalProfitPercent,
            totalCost: finalTotalCost,
            totalProfit: finalTotalProfit,
            type: 'customer',
            items: {
              create: txItemsData,
            },
          },
        });
      }

      return { updated: updatedDebt, createdTx: newTx };
    });

    if (createdTx) {
      notifyCustomerUpdate(userId, 'CREATE_TRANSACTION', {
        customerId: targetCustomerId,
        transactionId: createdTx.id,
      });
    }

    const oldItemsSummary = (existingDebt.items || [])
      .map((it) => `${it.product?.name || 'Món'}: ${it.quantity}${it.product?.unit || 'kg'} x ${Number(it.price).toLocaleString('vi-VN')}đ`)
      .join(', ');
    const newItemsSummary = (updated.items || [])
      .map((it) => `${it.product?.name || 'Món'}: ${it.quantity}${it.product?.unit || 'kg'} x ${Number(it.price).toLocaleString('vi-VN')}đ`)
      .join(', ');

    const oldTotalStr = `${Number(existingDebt.totalAmount).toLocaleString('vi-VN')}đ`;
    const newTotalStr = `${Number(calculatedTotal).toLocaleString('vi-VN')}đ`;

    const logDetail = `Cập nhật đơn nợ cố định của khách hàng ${customer.name}:\n• Trước: ${oldTotalStr} [${oldItemsSummary || 'Trống'}]\n• Sau: ${newTotalStr} [${newItemsSummary || 'Trống'}]`;

    await logActivity(
      userId,
      'UPDATE_RECURRING_DEBT',
      logDetail
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
