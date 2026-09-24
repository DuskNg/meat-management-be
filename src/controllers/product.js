// meat-management-be/src/controllers/product.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');
const { emitWorkspaceEvent } = require('../utils/socket');

// Helper gửi socket event thông báo giao dịch / nợ khách hàng thay đổi
const notifyCustomerUpdate = (userId, action, payload = {}) => {
  emitWorkspaceEvent(userId, 'CUSTOMER_UPDATED', {
    action,
    userId,
    timestamp: new Date().toISOString(),
    ...payload,
  });
};

// 1. Lấy danh sách sản phẩm hoạt động của chủ buôn đang đăng nhập (hỗ trợ lấy giá riêng theo khách hàng)
const getProducts = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { customerId } = req.query;

    const products = await prisma.product.findMany({
      where: {
        userId,
        isActive: true, // Chỉ lấy các sản phẩm đang hoạt động
      },
      orderBy: {
        name: 'asc', // Sắp xếp theo tên sản phẩm A-Z
      },
    });

    // Nếu có customerId, lấy giá bán riêng của khách hàng này để ghi đè lên giá chung mặc định
    if (customerId) {
      const customPrices = await prisma.customerProductPrice.findMany({
        where: {
          customerId,
        },
      });

      const priceMap = new Map(
        customPrices.map((cp) => [cp.productId, { price: cp.price, costPrice: cp.costPrice }])
      );

      const customProducts = products.map((p) => {
        if (priceMap.has(p.id)) {
          const cp = priceMap.get(p.id);
          return {
            ...p,
            baseDefaultPrice: p.defaultPrice,
            hasCustomPrice: true,
            customPrice: cp.price,
            defaultPrice: cp.price !== undefined && cp.price !== null ? cp.price : p.defaultPrice,
            costPrice: cp.costPrice !== undefined && cp.costPrice !== null ? cp.costPrice : p.costPrice,
          };
        }
        return {
          ...p,
          baseDefaultPrice: p.defaultPrice,
          hasCustomPrice: false,
          customPrice: null,
        };
      });

      return res.status(200).json({
        success: true,
        data: customProducts,
      });
    }

    res.status(200).json({
      success: true,
      data: products,
    });
  } catch (error) {
    next(error);
  }
};

// 2. Tạo sản phẩm mới
const createProduct = async (req, res, next) => {
  try {
    const { name, defaultPrice, costPrice, unit } = req.body;
    const userId = req.effectiveUserId;

    if (!name || defaultPrice === undefined) {
      throw new BadRequestError('Tên sản phẩm và giá bán mặc định là bắt buộc.');
    }

    const product = await prisma.product.create({
      data: {
        userId,
        createdBy: req.user.id,
        name,
        defaultPrice: parseFloat(defaultPrice),
        costPrice: costPrice !== undefined ? parseFloat(costPrice) : 0,
        unit: unit || 'kg',
      },
    });

    // Ghi log hoạt động
    await logActivity(
      userId,
      'CREATE_PRODUCT',
      `Tạo sản phẩm mới: ${product.name} (Giá bán: ${Number(product.defaultPrice).toLocaleString('vi-VN')}đ, Giá nhập: ${Number(product.costPrice).toLocaleString('vi-VN')}đ/${product.unit})`
    );

    res.status(201).json({
      success: true,
      data: product,
    });
  } catch (error) {
    next(error);
  }
};

// 3. Cập nhật thông tin sản phẩm
const updateProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, defaultPrice, costPrice, unit } = req.body;
    const userId = req.effectiveUserId;

    // Kiểm tra sản phẩm có tồn tại và thuộc chủ buôn này không
    const productExists = await prisma.product.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!productExists) {
      throw new NotFoundError('Không tìm thấy sản phẩm hoặc bạn không có quyền chỉnh sửa.');
    }

    const updatedProduct = await prisma.product.update({
      where: { id },
      data: {
        name: name !== undefined ? name : undefined,
        defaultPrice: defaultPrice !== undefined ? parseFloat(defaultPrice) : undefined,
        costPrice: costPrice !== undefined ? parseFloat(costPrice) : undefined,
        unit: unit !== undefined ? unit : undefined,
      },
    });

    // Ghi log hoạt động
    await logActivity(
      userId,
      'UPDATE_PRODUCT',
      `Cập nhật sản phẩm: ${productExists.name} (Giá bán: ${Number(productExists.defaultPrice).toLocaleString('vi-VN')}đ, Giá nhập: ${Number(productExists.costPrice).toLocaleString('vi-VN')}đ) -> ${updatedProduct.name} (Giá bán: ${Number(updatedProduct.defaultPrice).toLocaleString('vi-VN')}đ, Giá nhập: ${Number(updatedProduct.costPrice).toLocaleString('vi-VN')}đ)`
    );

    res.status(200).json({
      success: true,
      data: updatedProduct,
    });
  } catch (error) {
    next(error);
  }
};

// 4. Xóa mềm sản phẩm (Deactivate)
const deleteProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.effectiveUserId;

    // Kiểm tra sản phẩm có tồn tại và thuộc chủ buôn này không
    const productExists = await prisma.product.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!productExists) {
      throw new NotFoundError('Không tìm thấy sản phẩm hoặc bạn không có quyền xóa.');
    }

    // Kiểm tra bảo vệ dữ liệu chéo: Nhân viên chỉ được xóa dữ liệu do chính mình tạo. Chủ Workspace và Admin tối cao có toàn quyền.
    const actorId = req.user.id;
    const actorIsAdmin = req.user.isAdmin === true;
    if (!actorIsAdmin && productExists.createdBy !== actorId && actorId !== productExists.userId) {
      throw new ForbiddenError('Tài khoản của bạn không có quyền xóa dữ liệu do người khác tạo.');
    }

    // Ẩn sản phẩm đi bằng cách set isActive = false
    await prisma.product.update({
      where: { id },
      data: {
        isActive: false,
      },
    });

    // Ghi log hoạt động
    await logActivity(
      userId,
      'DELETE_PRODUCT',
      `Ẩn sản phẩm: ${productExists.name} (Giá mặc định: ${Number(productExists.defaultPrice).toLocaleString('vi-VN')}đ/${productExists.unit})`
    );

    res.status(200).json({
      success: true,
      message: 'Đã ẩn sản phẩm thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 5. Lấy danh sách các loại thịt của từng khách hàng được cập nhật giá trong ngày
// Helper: Chuẩn hóa chuỗi ngày (DD/MM/YYYY hoặc YYYY-MM-DD) sang YYYY-MM-DD
const normalizeDateStr = (str) => {
  if (!str) return null;
  const trimmed = str.trim();
  if (trimmed.includes('/')) {
    const [d, m, y] = trimmed.split('/');
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return trimmed;
};

// Helper: Chuẩn hóa chuỗi ngày hoặc đối tượng Date thành chuỗi YYYY-MM-DD theo múi giờ Việt Nam (+7)
const getVnDateString = (input) => {
  if (!input) return null;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.includes('/')) {
      const parts = trimmed.split('/');
      if (parts.length === 3) {
        const [d, m, y] = parts;
        return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      }
    }
    if (trimmed.includes('T')) {
      const d = new Date(trimmed);
      if (!isNaN(d.getTime())) {
        const vnTime = new Date(d.getTime() + 7 * 60 * 60 * 1000);
        return vnTime.toISOString().split('T')[0];
      }
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }
  }
  if (input instanceof Date && !isNaN(input.getTime())) {
    const vnTime = new Date(input.getTime() + 7 * 60 * 60 * 1000);
    return vnTime.toISOString().split('T')[0];
  }
  return null;
};

// Helper: Kiểm tra xem sản phẩm có phải là "Tiền hàng" (ghi nợ nhanh / tiền hàng) hay không
const isQuickMoneyProduct = (name, note) => {
  if (note && (note.toLowerCase().includes('ghi nợ nhanh') || note.toLowerCase().includes('nợ nhanh'))) {
    return true;
  }
  if (!name) return false;
  const n = name.trim().toLowerCase();
  return n === 'tiền hàng' || n.startsWith('tiền') || n.includes('tiền hàng');
};

// 5. Quan sát các đơn nợ và trích xuất danh sách giá thịt được cập nhật (so sánh với đơn trước / ngày trước)
// Hỗ trợ bộ lọc từ ngày đến ngày (fromDate / toDate)
const getDailyPriceUpdates = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { date, fromDate, toDate, startDate, endDate } = req.query;

    const now = new Date();
    const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const todayStr = vnNow.toISOString().split('T')[0];

    const startNorm = normalizeDateStr(fromDate || startDate) || normalizeDateStr(date) || todayStr;
    const endNorm = normalizeDateStr(toDate || endDate) || normalizeDateStr(date) || startNorm;

    const [sYear, sMonth, sDay] = startNorm.split('-').map(Number);
    const [eYear, eMonth, eDay] = endNorm.split('-').map(Number);

    const startUtc = new Date(Date.UTC(sYear, sMonth - 1, sDay, -7, 0, 0, 0));
    const endUtc = new Date(Date.UTC(eYear, eMonth - 1, eDay, 16, 59, 59, 999));

    // 1. Lấy tất cả các giao dịch trong khoảng thời gian [startUtc, endUtc]
    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        date: {
          gte: startUtc,
          lte: endUtc,
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
              },
            },
          },
        },
      },
      orderBy: [
        { date: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    // Gom danh sách khách hàng và sản phẩm xuất hiện trong các đơn nợ kỳ này (Loại bỏ Tiền hàng)
    const customerIds = new Set();
    const productIds = new Set();

    transactions.forEach((t) => {
      if (t.customerId) customerIds.add(t.customerId);
      (t.items || []).forEach((it) => {
        const prodName = it.product?.name || '';
        if (it.productId && !isQuickMoneyProduct(prodName, t.note)) {
          productIds.add(it.productId);
        }
      });
    });

    // 2. Gom danh sách ID các giao dịch thuộc kỳ lọc để nhận diện lần hiện tại
    const targetTxIds = new Set(transactions.map((t) => t.id));
    const priceChanges = [];

    if (customerIds.size > 0 && productIds.size > 0) {
      // Truy vấn toàn bộ các dòng thịt trong lịch sử giao dịch từ trước đến hết kỳ lọc
      // Sắp xếp theo trình tự thời gian tăng dần để duyệt tuần tự
      const allHistoricalItems = await prisma.transactionItem.findMany({
        where: {
          productId: { in: Array.from(productIds) },
          transaction: {
            userId,
            customerId: { in: Array.from(customerIds) },
            date: { lte: endUtc },
          },
        },
        include: {
          transaction: {
            select: {
              id: true,
              customerId: true,
              date: true,
              createdAt: true,
              note: true,
              customer: {
                select: {
                  id: true,
                  name: true,
                  phone: true,
                },
              },
            },
          },
          product: {
            select: {
              id: true,
              name: true,
              unit: true,
            },
          },
        },
        orderBy: [
          { transaction: { date: 'asc' } },
          { transaction: { createdAt: 'asc' } },
          { id: 'asc' },
        ],
      });

      // Lưu trữ đơn giá mới nhất của từng khách hàng và từng loại thịt theo dòng thời gian
      const historyPriceMap = new Map(); // key: `${customerId}_${productId}` => { price, date, createdAt }

      for (const item of allHistoricalItems) {
        if (!item.product || !item.transaction?.customer) continue;
        // Bỏ qua Tiền hàng hoặc ghi nợ nhanh
        if (isQuickMoneyProduct(item.product.name, item.transaction.note)) continue;

        const cId = item.transaction.customerId;
        const pId = item.productId;
        const key = `${cId}_${pId}`;
        const currentPrice = parseFloat(item.price || 0);
        const isCurrentPeriodItem = targetTxIds.has(item.transaction.id);

        const prevRecord = historyPriceMap.get(key);

        // Nếu dòng này thuộc kỳ lọc hiện tại và trước đó đã có giá lưu trữ
        if (isCurrentPeriodItem && prevRecord && typeof prevRecord.price === 'number') {
          const oldPrice = prevRecord.price;
          // Nếu đơn giá của lần hiện tại khác với đơn giá của lần mới nhất đang lưu trữ (lệch tối thiểu 1đ)
          if (Math.abs(currentPrice - oldPrice) > 0.01) {
            const diff = currentPrice - oldPrice;
            const diffPercent = oldPrice > 0 ? Math.round((diff / oldPrice) * 1000) / 10 : 0;

            priceChanges.push({
              id: `${item.transaction.id}_${item.id}`,
              transactionId: item.transaction.id,
              customerId: cId,
              customerName: item.transaction.customer.name,
              customerPhone: item.transaction.customer.phone || '',
              productId: pId,
              productName: item.product.name,
              unit: item.product.unit || 'kg',
              oldPrice,
              newPrice: currentPrice,
              diff,
              diffPercent,
              quantity: parseFloat(item.quantity || 0),
              date: item.transaction.date,
              createdAt: item.transaction.createdAt,
              prevDate: prevRecord.date,
            });
          }
        }

        // Cập nhật giá mới nhất đang lưu trữ làm mốc so sánh cho các lần tiếp theo
        historyPriceMap.set(key, {
          price: currentPrice,
          date: item.transaction.date,
          createdAt: item.transaction.createdAt,
        });
      }
    }

    // 4. Nhóm theo khách hàng để hiển thị trực quan
    const customerGroupMap = new Map();
    for (const change of priceChanges) {
      const cId = change.customerId;
      if (!customerGroupMap.has(cId)) {
        customerGroupMap.set(cId, {
          customerId: cId,
          customerName: change.customerName,
          customerPhone: change.customerPhone,
          lastUpdatedAt: change.createdAt,
          changes: [],
        });
      }

      const group = customerGroupMap.get(cId);
      group.changes.push(change);
      if (new Date(change.createdAt) > new Date(group.lastUpdatedAt)) {
        group.lastUpdatedAt = change.createdAt;
      }
    }

    const groupedCustomers = Array.from(customerGroupMap.values());
    groupedCustomers.sort((a, b) => new Date(b.lastUpdatedAt) - new Date(a.lastUpdatedAt));

    // Thống kê tổng hợp
    let increasedCount = 0;
    let decreasedCount = 0;
    const uniqueProducts = new Set();

    priceChanges.forEach((c) => {
      if (c.diff > 0) increasedCount++;
      else if (c.diff < 0) decreasedCount++;
      uniqueProducts.add(c.productName);
    });

    res.status(200).json({
      success: true,
      data: {
        fromDate: startNorm,
        toDate: endNorm,
        totalUpdates: priceChanges.length,
        totalCustomers: groupedCustomers.length,
        increasedCount,
        decreasedCount,
        uniqueProductsCount: uniqueProducts.size,
        uniqueProductsList: Array.from(uniqueProducts),
        customers: groupedCustomers,
        allChanges: priceChanges.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
      },
    });
  } catch (error) {
    next(error);
  }
};

// 6. Cập nhật đơn giá thịt cho khách hàng VÀ nhân lại đơn hàng với giá mới
const updateCustomerProductPrice = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { customerId, productId, price, transactionId, date, recalculateOrder } = req.body;

    if (!customerId || !productId || price === undefined) {
      throw new BadRequestError('customerId, productId và price là bắt buộc.');
    }

    const numericPrice = parseFloat(price);
    if (isNaN(numericPrice) || numericPrice < 0) {
      throw new BadRequestError('Đơn giá không hợp lệ.');
    }

    // Kiểm tra khách hàng và sản phẩm có thuộc chủ buôn này không
    const [customer, product] = await Promise.all([
      prisma.customer.findFirst({
        where: { id: customerId, userId, isActive: true },
      }),
      prisma.product.findFirst({
        where: { id: productId, userId, isActive: true },
      }),
    ]);

    if (!customer) {
      throw new NotFoundError('Không tìm thấy khách hàng.');
    }
    if (!product) {
      throw new NotFoundError('Không tìm thấy sản phẩm thịt.');
    }

    // Lấy giá riêng hiện tại trước khi cập nhật
    const existingCustomPrice = await prisma.customerProductPrice.findUnique({
      where: {
        customerId_productId: {
          customerId,
          productId,
        },
      },
    });
    const oldPriceStr = existingCustomPrice
      ? `${Number(existingCustomPrice.price).toLocaleString('vi-VN')}đ`
      : `Mặc định ${Number(product.defaultPrice).toLocaleString('vi-VN')}đ`;
    const newPriceStr = `${Number(numericPrice).toLocaleString('vi-VN')}đ`;

    // Thực hiện cập nhật giá riêng và nhân lại đơn hàng trong Prisma Transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Cập nhật hoặc lưu mới đơn giá bán riêng cho khách hàng
      const updatedPrice = await tx.customerProductPrice.upsert({
        where: {
          customerId_productId: {
            customerId,
            productId,
          },
        },
        update: {
          price: numericPrice,
        },
        create: {
          customerId,
          productId,
          price: numericPrice,
        },
      });

      // 2. Nhân lại đơn hàng với giá mới
      let affectedTransactions = [];

      if (transactionId) {
        // Nếu có chỉ định đơn hàng cụ thể
        const targetTx = await tx.transaction.findFirst({
          where: { id: transactionId, userId, customerId },
          include: { items: true },
        });
        if (targetTx) {
          affectedTransactions.push(targetTx);
        }
      }

      // Nếu có ngày cụ thể: nhân lại toàn bộ đơn nợ của khách hàng trong ngày đó có chứa mặt hàng này
      if (date) {
        const vnDateStr = getVnDateString(date);
        if (vnDateStr) {
          const [year, month, day] = vnDateStr.split('-').map(Number);
          const dayStart = new Date(Date.UTC(year, month - 1, day, -7, 0, 0, 0));
          const dayEnd = new Date(Date.UTC(year, month - 1, day, 16, 59, 59, 999));

          const dateTxs = await tx.transaction.findMany({
            where: {
              userId,
              customerId,
              date: {
                gte: dayStart,
                lte: dayEnd,
              },
              items: {
                some: { productId },
              },
            },
            include: { items: true },
          });

          for (const dTx of dateTxs) {
            if (!affectedTransactions.some((t) => t.id === dTx.id)) {
              affectedTransactions.push(dTx);
            }
          }
        }
      } else if (!transactionId && recalculateOrder) {
        // Nếu không chỉ định đơn hàng cụ thể và không có ngày, tìm đơn hàng gần nhất có mặt hàng này
        const recentTxs = await tx.transaction.findMany({
          where: {
            userId,
            customerId,
            items: {
              some: { productId },
            },
          },
          include: { items: true },
          orderBy: { date: 'desc' },
          take: 1,
        });
        affectedTransactions = recentTxs;
      }

      // Duyệt và tính lại từng đơn hàng bị ảnh hưởng
      for (const trans of affectedTransactions) {
        let hasItemUpdated = false;

        for (const it of trans.items) {
          if (it.productId === productId) {
            const qty = parseFloat(it.quantity || 0);
            const cost = parseFloat(it.costPrice || 0);
            const newAmount = Math.round(qty * numericPrice);
            const newProfit = newAmount - Math.round(qty * cost);

            await tx.transactionItem.update({
              where: { id: it.id },
              data: {
                price: numericPrice,
                amount: newAmount,
                profit: newProfit,
              },
            });
            hasItemUpdated = true;
          }
        }

        if (hasItemUpdated) {
          // Lấy lại danh sách mặt hàng sau cập nhật để tính tổng tiền đơn hàng
          const allItems = await tx.transactionItem.findMany({
            where: { transactionId: trans.id },
          });

          let newTotalAmount = 0;
          let newTotalCost = 0;
          let newTotalProfit = 0;

          for (const it of allItems) {
            const a = parseFloat(it.amount || 0);
            const q = parseFloat(it.quantity || 0);
            const c = parseFloat(it.costPrice || 0);
            const p = parseFloat(it.profit || 0);

            newTotalAmount += a;
            newTotalCost += Math.round(q * c);
            newTotalProfit += p;
          }

          // Xử lý tỉ lệ % lợi nhuận nếu đơn nợ có cấu hình riêng
          if (trans.profitPercent !== null && !isNaN(parseFloat(trans.profitPercent))) {
            const pct = parseFloat(trans.profitPercent);
            newTotalProfit = Math.round(newTotalAmount * (pct / 100));
            newTotalCost = newTotalAmount - newTotalProfit;
          }

          await tx.transaction.update({
            where: { id: trans.id },
            data: {
              totalAmount: newTotalAmount,
              totalCost: newTotalCost,
              totalProfit: newTotalProfit,
            },
          });
        }
      }

      return {
        updatedPrice,
        recalculatedCount: affectedTransactions.length,
      };
    });

    // Ghi log hoạt động
    const recalcNote = result.recalculatedCount > 0 ? ` (Tự động tính lại ${result.recalculatedCount} đơn nợ)` : '';
    await logActivity(
      userId,
      'UPDATE_CUSTOMER_PRICE',
      `Cập nhật giá riêng cho khách "${customer.name}": Thịt "${product.name}" (Trước: ${oldPriceStr} ➔ Sau: ${newPriceStr}/${product.unit})${recalcNote}`
    );

    // Bắn socket thông báo cập nhật đơn nợ và công nợ khách hàng
    if (result.recalculatedCount > 0) {
      notifyCustomerUpdate(userId, 'UPDATE_TRANSACTION', { customerId, transactionId });
    }
    notifyCustomerUpdate(userId, 'UPDATE_CUSTOMER', { customerId });

    res.status(200).json({
      success: true,
      message: 'Đã cập nhật giá thịt và nhân lại đơn hàng thành công.',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// 7. Cập nhật giá bán và giá nhập đồng loạt cho nhiều loại thịt
const batchUpdateProductPrices = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { items } = req.body; // Array: [{ id, defaultPrice, costPrice }]

    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestError('Danh sách sản phẩm cập nhật giá không được để trống.');
    }

    const updatedItems = [];
    const logDetails = [];

    // Thực hiện trong transaction để cập nhật nhanh và bảo đảm an toàn dữ liệu
    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        if (!item.id) continue;
        const defaultPrice = item.defaultPrice !== undefined ? parseFloat(item.defaultPrice) : undefined;
        const costPrice = item.costPrice !== undefined ? parseFloat(item.costPrice) : undefined;

        // Kiểm tra sản phẩm thuộc chủ buôn này
        const existing = await tx.product.findFirst({
          where: { id: item.id, userId, isActive: true },
        });
        if (!existing) continue;

        const updateData = {};
        if (defaultPrice !== undefined && !isNaN(defaultPrice) && defaultPrice >= 0) {
          updateData.defaultPrice = defaultPrice;
        }
        if (costPrice !== undefined && !isNaN(costPrice) && costPrice >= 0) {
          updateData.costPrice = costPrice;
        }

        if (Object.keys(updateData).length > 0) {
          const updated = await tx.product.update({
            where: { id: item.id },
            data: updateData,
          });
          updatedItems.push(updated);
          logDetails.push(
            `${existing.name}: Bán ${Number(existing.defaultPrice).toLocaleString('vi-VN')}đ -> ${Number(updated.defaultPrice).toLocaleString('vi-VN')}đ, Nhập ${Number(existing.costPrice).toLocaleString('vi-VN')}đ -> ${Number(updated.costPrice).toLocaleString('vi-VN')}đ`
          );
        }
      }
    });

    if (logDetails.length > 0) {
      await logActivity(
        userId,
        'BATCH_UPDATE_PRODUCT_PRICES',
        `Cập nhật giá đồng loạt cho ${logDetails.length} loại thịt: ${logDetails.slice(0, 5).join('; ')}${logDetails.length > 5 ? ` và ${logDetails.length - 5} loại khác` : ''}`
      );
    }

    res.status(200).json({
      success: true,
      message: `Đã cập nhật giá thành công cho ${updatedItems.length} loại thịt.`,
      data: updatedItems,
    });
  } catch (error) {
    next(error);
  }
};

// 8. Cập nhật giá thịt riêng cho một hoặc nhiều khách hàng (theo từng khách hoặc theo nhóm)
const batchUpdateCustomerProductPrices = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { customerIds, items } = req.body; // customerIds: string[], items: [{ productId, price, costPrice, resetToDefault }]

    if (!Array.isArray(customerIds) || customerIds.length === 0) {
      throw new BadRequestError('Danh sách khách hàng (customerIds) không được để trống.');
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestError('Danh sách giá sản phẩm (items) không được để trống.');
    }

    // Xác thực danh sách khách hàng thuộc chủ buôn này
    const validCustomers = await prisma.customer.findMany({
      where: {
        id: { in: customerIds },
        userId,
        isActive: true,
      },
      select: { id: true, name: true },
    });

    if (validCustomers.length === 0) {
      throw new NotFoundError('Không tìm thấy khách hàng hợp lệ nào.');
    }

    const validCustomerIds = validCustomers.map(c => c.id);

    // Xác thực danh sách sản phẩm thuộc chủ buôn này
    const productIds = items.map(it => it.productId).filter(Boolean);
    const validProducts = await prisma.product.findMany({
      where: {
        id: { in: productIds },
        userId,
        isActive: true,
      },
      select: { id: true, name: true, defaultPrice: true },
    });
    const validProductMap = new Map(validProducts.map(p => [p.id, p]));

    // Lấy giá riêng hiện tại của các khách này trước khi cập nhật để so sánh
    const existingCustomPrices = await prisma.customerProductPrice.findMany({
      where: {
        customerId: { in: validCustomerIds },
        productId: { in: productIds },
      },
    });
    const oldPriceMap = new Map();
    existingCustomPrices.forEach((cp) => {
      oldPriceMap.set(`${cp.customerId}_${cp.productId}`, cp.price);
    });

    const priceDiffs = [];
    let totalUpdated = 0;

    await prisma.$transaction(async (tx) => {
      for (const cId of validCustomerIds) {
        for (const item of items) {
          if (!item.productId || !validProductMap.has(item.productId)) continue;

          const prod = validProductMap.get(item.productId);
          const oldPriceVal = oldPriceMap.get(`${cId}_${item.productId}`);
          const oldPriceStr = oldPriceVal !== undefined && oldPriceVal !== null
            ? `${Number(oldPriceVal).toLocaleString('vi-VN')}đ`
            : `Mặc định (${Number(prod?.defaultPrice || 0).toLocaleString('vi-VN')}đ)`;

          // Nếu có yêu cầu khôi phục giá mặc định, xóa bản ghi giá riêng
          if (item.resetToDefault || item.price === null) {
            await tx.customerProductPrice.deleteMany({
              where: {
                customerId: cId,
                productId: item.productId,
              },
            });
            totalUpdated++;

            const cust = validCustomers.find((c) => c.id === cId);
            priceDiffs.push({
              customerName: cust?.name || 'Khách',
              productName: prod?.name || 'Thịt',
              oldPrice: oldPriceStr,
              newPrice: `Về mặc định (${Number(prod?.defaultPrice || 0).toLocaleString('vi-VN')}đ)`,
            });
            continue;
          }

          const numPrice = parseFloat(item.price);
          if (isNaN(numPrice) || numPrice < 0) continue;

          const numCostPrice = item.costPrice !== undefined && item.costPrice !== null
            ? parseFloat(item.costPrice)
            : undefined;

          await tx.customerProductPrice.upsert({
            where: {
              customerId_productId: {
                customerId: cId,
                productId: item.productId,
              },
            },
            update: {
              price: numPrice,
              ...(numCostPrice !== undefined && !isNaN(numCostPrice) ? { costPrice: numCostPrice } : {}),
            },
            create: {
              customerId: cId,
              productId: item.productId,
              price: numPrice,
              ...(numCostPrice !== undefined && !isNaN(numCostPrice) ? { costPrice: numCostPrice } : {}),
            },
          });
          totalUpdated++;

          const cust = validCustomers.find((c) => c.id === cId);
          priceDiffs.push({
            customerName: cust?.name || 'Khách',
            productName: prod?.name || 'Thịt',
            oldPrice: oldPriceStr,
            newPrice: `${Number(numPrice).toLocaleString('vi-VN')}đ`,
          });
        }
      }
    });

    // Ghi log hoạt động với chi tiết giá trước và sau khi sửa
    let logDetail = '';
    if (validCustomers.length === 1) {
      const custName = validCustomers[0].name;
      const changesText = priceDiffs
        .map((pd) => `${pd.productName} (Trước: ${pd.oldPrice} ➔ Sau: ${pd.newPrice})`)
        .join('; ');
      logDetail = `Cập nhật giá riêng cho khách "${custName}":\n• ${changesText || `${items.length} loại thịt`}`;
    } else {
      const customerNames = validCustomers.map((c) => c.name).slice(0, 3).join(', ');
      const moreCust = validCustomers.length > 3 ? ` và ${validCustomers.length - 3} khách khác` : '';
      const sampleDiffs = priceDiffs
        .slice(0, 5)
        .map((pd) => `${pd.customerName} - ${pd.productName} (${pd.oldPrice} ➔ ${pd.newPrice})`)
        .join('; ');
      const moreDiffs = priceDiffs.length > 5 ? `... (+${priceDiffs.length - 5} loại nữa)` : '';
      logDetail = `Cập nhật giá riêng cho ${validCustomers.length} khách (${customerNames}${moreCust}):\n• ${sampleDiffs}${moreDiffs}`;
    }

    await logActivity(
      userId,
      'BATCH_UPDATE_CUSTOMER_PRICES',
      logDetail
    );

    // Bắn socket thông báo đồng bộ realtime cho từng khách hàng
    validCustomerIds.forEach(cId => {
      notifyCustomerUpdate(userId, 'UPDATE_CUSTOMER', { customerId: cId });
    });

    res.status(200).json({
      success: true,
      message: `Đã cập nhật giá riêng thành công cho ${validCustomers.length} cửa hàng.`,
      data: {
        customerCount: validCustomers.length,
        totalUpdated,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Phân tích giá nhóm cửa hàng: với mỗi sản phẩm, tính giá phổ biến nhất
 * trong nhóm (mode) và xác định cửa hàng nào đang có giá khác số đông
 * POST /api/v1/products/group-price-analysis
 * Body: { customerIds: string[] }
 */
const analyzeGroupPrices = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { customerIds } = req.body;

    if (!Array.isArray(customerIds) || customerIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Danh sách customerIds không hợp lệ.' });
    }

    // Xác thực các customerId thuộc workspace này
    const validCustomers = await prisma.customer.findMany({
      where: { id: { in: customerIds }, userId },
      select: { id: true, name: true },
    });
    const validCustomerIds = validCustomers.map(c => c.id);
    const customerMap = Object.fromEntries(validCustomers.map(c => [c.id, c.name]));

    if (validCustomerIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Không tìm thấy cửa hàng hợp lệ.' });
    }

    // Lấy danh sách sản phẩm đang hoạt động
    const products = await prisma.product.findMany({
      where: { userId, isActive: true },
      orderBy: { name: 'asc' },
    });

    // Lấy toàn bộ giá riêng của tất cả khách trong nhóm
    const allCustomPrices = await prisma.customerProductPrice.findMany({
      where: {
        customerId: { in: validCustomerIds },
        productId: { in: products.map(p => p.id) },
      },
    });

    // Tổ chức lại: map productId -> customerId -> price
    const priceByProductCustomer = {};
    for (const cp of allCustomPrices) {
      if (!priceByProductCustomer[cp.productId]) {
        priceByProductCustomer[cp.productId] = {};
      }
      priceByProductCustomer[cp.productId][cp.customerId] = cp.price;
    }

    // Tính giá phổ biến nhất (mode) cho từng sản phẩm
    const result = products
      .filter(p => p.name !== 'Tiền hàng' && !p.name.toLowerCase().startsWith('tiền'))
      .map(p => {
        // Tập hợp giá của từng cửa hàng trong nhóm (nếu không có giá riêng thì dùng giá chung)
        const pricePerCustomer = validCustomerIds.map(cId => ({
          customerId: cId,
          customerName: customerMap[cId] || cId,
          price: priceByProductCustomer[p.id]?.[cId] ?? p.defaultPrice,
          hasCustomPrice: priceByProductCustomer[p.id]?.[cId] !== undefined,
        }));

        // Đếm tần suất xuất hiện của từng mức giá
        const priceFrequency = {};
        for (const pc of pricePerCustomer) {
          const key = String(pc.price);
          if (!priceFrequency[key]) priceFrequency[key] = { price: pc.price, count: 0, customerIds: [] };
          priceFrequency[key].count++;
          priceFrequency[key].customerIds.push(pc.customerId);
        }

        // Tìm giá phổ biến nhất (mode) - nếu hòa thì ưu tiên giá chung mặc định
        const freqEntries = Object.values(priceFrequency).sort((a, b) => {
          if (b.count !== a.count) return b.count - a.count;
          // Nếu count bằng nhau: ưu tiên giá chung mặc định
          if (a.price === p.defaultPrice) return -1;
          if (b.price === p.defaultPrice) return 1;
          return 0;
        });

        const majorityPrice = freqEntries[0]?.price ?? p.defaultPrice;
        const majorityCount = freqEntries[0]?.count ?? 0;

        // Xác định outliers: cửa hàng có giá khác với giá phổ biến nhất
        const outliers = pricePerCustomer
          .filter(pc => pc.price !== majorityPrice)
          .map(pc => ({
            customerId: pc.customerId,
            customerName: pc.customerName,
            currentPrice: pc.price,
            hasCustomPrice: pc.hasCustomPrice,
          }));

        return {
          id: p.id,
          name: p.name,
          unit: p.unit,
          baseDefaultPrice: p.defaultPrice,
          costPrice: p.costPrice,
          majorityPrice,
          majorityCount,
          totalCount: validCustomerIds.length,
          outlierCount: outliers.length,
          outliers,
          priceBreakdown: freqEntries,
        };
      });

    return res.status(200).json({
      success: true,
      data: {
        customers: validCustomers,
        products: result,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  getDailyPriceUpdates,
  updateCustomerProductPrice,
  batchUpdateProductPrices,
  batchUpdateCustomerProductPrices,
  analyzeGroupPrices,
};


