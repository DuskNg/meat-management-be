// meat-management-be/src/controllers/transaction.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');
const { emitWorkspaceEvent } = require('../utils/socket');
const { isCloudinaryConfigured, uploadToCloudinary, deleteFromCloudinary } = require('../utils/cloudinary');

// Helper gửi socket event thông báo giao dịch / nợ khách hàng thay đổi
const notifyCustomerUpdate = (userId, action, payload = {}) => {
  emitWorkspaceEvent(userId, 'CUSTOMER_UPDATED', {
    action,
    userId,
    timestamp: new Date().toISOString(),
    ...payload,
  });
};


// 1. Tạo đơn hàng ghi nợ mới (Transaction)
const createTransaction = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { customerId, date, note, items, source, isBatch, profitPercent, priceChangeReason, updateCustomPrice } = req.body;

    if (!customerId) {
      throw new BadRequestError('Mã khách hàng là bắt buộc.');
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestError('Đơn hàng phải có ít nhất một dòng mặt hàng.');
    }

    // Kiểm tra khách hàng có tồn tại và thuộc chủ buôn này không
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, userId, isActive: true },
    });

    if (!customer) {
      throw new NotFoundError('Không tìm thấy khách hàng hoặc khách hàng đã bị xóa.');
    }

    // Lấy toàn bộ sản phẩm thịt liên quan để xác thực
    const productIds = items.filter((i) => i.productId).map((i) => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, userId, isActive: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    // Lấy danh mục sản phẩm đầy đủ của chủ buôn này để so khớp khi sửa tên
    const allUserProducts = await prisma.product.findMany({
      where: { userId, isActive: true },
    });

    // Kiểm tra tính hợp lệ và tính tổng tiền, tổng vốn, tổng lãi của từng dòng mặt hàng
    let calculatedTotal = 0;
    let calculatedTotalCost = 0;
    let calculatedTotalProfit = 0;
    const formattedItems = [];

    for (const item of items) {
      const { productId, productName, quantity: reqQuantity, price: reqPrice, costPrice: reqCostPrice } = item;

      if (reqQuantity === undefined || reqPrice === undefined) {
        throw new BadRequestError('Mỗi dòng mặt hàng phải chứa thông tin số lượng và giá bán.');
      }

      let finalProductId = productId;

      // Nếu có tên sản phẩm được cung cấp (cho phép sửa hoặc tạo mới trên giao diện)
      if (productName && productName.trim()) {
        const trimmedName = productName.trim();
        const normScanned = trimmedName.toLowerCase().replace(/\s+/g, '');

        // Kiểm tra xem tên mới có trùng khớp với sản phẩm hiện tại của productId hay không
        const currentProd = productId ? productMap.get(productId) : null;
        const currentProdNameNorm = currentProd ? currentProd.name.toLowerCase().replace(/\s+/g, '') : '';

        if (!currentProd || currentProdNameNorm !== normScanned) {
          // Người dùng đã sửa hoặc nhập tên sản phẩm mới! Tìm sản phẩm tương ứng trong danh sách của chủ buôn
          let matchedProduct = allUserProducts.find(
            (p) => p.name.toLowerCase().replace(/\s+/g, '') === normScanned
          );

          if (!matchedProduct) {
            // Tạo sản phẩm mới với đúng tên người dùng nhập để lưu lại chính xác
            matchedProduct = await prisma.product.create({
              data: {
                userId,
                createdBy: req.user.id,
                name: trimmedName,
                defaultPrice: parseFloat(reqPrice) || 0,
                costPrice: reqCostPrice !== undefined ? parseFloat(reqCostPrice) : 0,
                unit: 'kg',
              },
            });
            allUserProducts.push(matchedProduct);
            productMap.set(matchedProduct.id, matchedProduct);
          }
          finalProductId = matchedProduct.id;
        }
      }

      if (!finalProductId) {
        throw new BadRequestError('Không thể xác định hoặc tạo mới sản phẩm cho dòng mặt hàng này.');
      }

      // Xác thực lại sản phẩm
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

    // Xử lý % lợi nhuận nếu người dùng nhập riêng (áp dụng cho nợ nhanh)
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

    // Thực hiện lưu giao dịch và các chi tiết dòng vào database sử dụng Prisma Transaction
    const newTransaction = await prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.create({
        data: {
          userId,
          createdBy: req.user.id,
          customerId,
          date: date ? new Date(date) : new Date(),
          note: note || null,
          totalAmount: calculatedTotal,
          profitPercent: finalProfitPercent,
          totalCost: finalTotalCost,
          totalProfit: finalTotalProfit,
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

      // Cập nhật hoặc lưu mới đơn giá thịt của loại thịt này cho khách hàng này nếu được phép (mặc định true, nếu updateCustomPrice === false thì chỉ áp dụng cho lần nợ này)
      if (updateCustomPrice !== false) {
        for (const item of formattedItems) {
          await tx.customerProductPrice.upsert({
            where: {
              customerId_productId: {
                customerId,
                productId: item.productId,
              },
            },
            update: {
              price: item.price,
              ...(priceChangeReason !== undefined ? { changeReason: priceChangeReason?.trim() || null } : {}),
            },
            create: {
              customerId,
              productId: item.productId,
              price: item.price,
              changeReason: priceChangeReason?.trim() || null,
            },
          });
        }
      }

      // Tự động gắn các ảnh hóa đơn chưa được liên kết của khách này trong cùng ngày vào đơn nợ vừa tạo
      try {
        const txDateVN = new Date(transaction.date.getTime() + 7 * 60 * 60 * 1000);
        const startDayUTC = new Date(Date.UTC(txDateVN.getUTCFullYear(), txDateVN.getUTCMonth(), txDateVN.getUTCDate(), 0, 0, 0, 0) - 7 * 60 * 60 * 1000);
        const endDayUTC = new Date(Date.UTC(txDateVN.getUTCFullYear(), txDateVN.getUTCMonth(), txDateVN.getUTCDate(), 23, 59, 59, 999) - 7 * 60 * 60 * 1000);

        await tx.transactionInvoice.updateMany({
          where: {
            userId,
            customerId,
            transactionId: null,
            date: { gte: startDayUTC, lte: endDayUTC },
          },
          data: {
            transactionId: transaction.id,
          },
        });
      } catch (_) {}

      return transaction;
    });

    let methodTag = '[Ghi nợ thủ công]';
    if (source === 'BATCH_QUICK') {
      methodTag = '[Nhập nợ hàng loạt - Nợ nhanh]';
    } else if (source === 'BATCH_DETAIL') {
      methodTag = '[Nhập nợ hàng loạt - Nợ chi tiết]';
    } else if (isBatch || (note && note.toLowerCase().includes('hàng loạt'))) {
      methodTag = '[Nhập nợ hàng loạt]';
    } else if (source === 'SCAN_AI' || (note && note.toLowerCase().includes('tích kê'))) {
      methodTag = '[Chụp ảnh tích kê AI]';
    } else if (source === 'VOICE_AI' || (note && note.toLowerCase().includes('giọng nói'))) {
      methodTag = '[Giọng nói AI]';
    }

    const transDate = date ? new Date(date) : new Date();
    const dateStr = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }).format(transDate);

    await logActivity(
      userId,
      'CREATE_TRANSACTION',
      `${methodTag} Ghi nợ đơn hàng ngày ${dateStr} cho khách ${customer.name}: Tổng tiền ${calculatedTotal.toLocaleString('vi-VN')}đ`
    );
    notifyCustomerUpdate(userId, 'CREATE_TRANSACTION', { customerId, transactionId: newTransaction.id });

    res.status(201).json({
      success: true,
      data: newTransaction,
    });
  } catch (error) {
    next(error);
  }
};

// 2. Lấy danh sách hóa đơn giao dịch (có thể lọc theo khách hàng, người tạo, ngày hôm nay hoặc ngày cụ thể)
const getTransactions = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { customerId, createdBy, todayOnly, date, month } = req.query;

    const whereClause = { userId };
    if (customerId) {
      whereClause.customerId = customerId;
    }

    // Lọc theo người tạo đơn (dùng cho nhân viên xem đơn của mình)
    if (createdBy) {
      whereClause.createdBy = createdBy;
    }

    // Lọc theo ngày cụ thể hoặc tháng cụ thể (dùng chỉ mục date để tối ưu hóa 100x tốc độ)
    if (date) {
      const parts = date.includes('/') ? date.split('/') : date.split('-');
      if (parts.length === 3) {
        const isSlash = date.includes('/');
        const year = parseInt(isSlash ? parts[2] : parts[0], 10);
        const monthVal = parseInt(parts[1], 10) - 1;
        const dayVal = parseInt(isSlash ? parts[0] : parts[2], 10);

        const startUTC = new Date(Date.UTC(year, monthVal, dayVal, 0, 0, 0, 0) - 7 * 60 * 60 * 1000);
        const endUTC = new Date(Date.UTC(year, monthVal, dayVal, 23, 59, 59, 999) - 7 * 60 * 60 * 1000);
        whereClause.date = { gte: startUTC, lte: endUTC };
      }
    } else if (month) {
      const parts = month.split('/');
      if (parts.length === 2) {
        const m = parseInt(parts[0], 10) - 1;
        const y = parseInt(parts[1], 10);
        const startUTC = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0) - 7 * 60 * 60 * 1000);
        const endUTC = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999) - 7 * 60 * 60 * 1000);
        whereClause.date = { gte: startUTC, lte: endUTC };
      }
    } else if (todayOnly === 'true') {
      const now = new Date();
      const nowVN = new Date(now.getTime() + 7 * 60 * 60 * 1000);
      const year = nowVN.getUTCFullYear();
      const monthVal = nowVN.getUTCMonth();
      const dateVal = nowVN.getUTCDate();

      const startUTC = new Date(Date.UTC(year, monthVal, dateVal, 0, 0, 0, 0) - 7 * 60 * 60 * 1000);
      const endUTC = new Date(Date.UTC(year, monthVal, dateVal, 23, 59, 59, 999) - 7 * 60 * 60 * 1000);
      whereClause.date = { gte: startUTC, lte: endUTC };
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
                defaultPrice: true,
                costPrice: true,
              },
            },
          },
        },
        invoices: true, // Bao gồm danh sách ảnh hóa đơn đính kèm đơn nợ
      },
      orderBy: {
        date: 'desc', // Đơn hàng mới nhất hiển thị lên đầu
      },
    });

    // Tự động tính toán fallback lợi nhuận cho các đơn cũ hoặc khi chủ buôn vừa cập nhật giá nhập thịt
    const enrichedTransactions = transactions.map((t) => {
      let totalCost = parseFloat(t.totalCost || 0);
      let totalProfit = parseFloat(t.totalProfit || 0);

      const items = (t.items || []).map((item) => {
        const itemCostNum = parseFloat(item.costPrice || 0);
        const prodCostNum = parseFloat(item.product?.costPrice || 0);
        const costPrice = itemCostNum > 0 ? itemCostNum : prodCostNum;

        const qty = parseFloat(item.quantity || 0);
        const price = parseFloat(item.price || 0);
        const amount = item.amount !== null && item.amount !== undefined ? parseFloat(item.amount) : Math.round(qty * price);
        
        let profit = parseFloat(item.profit || 0);
        if (profit === 0 && costPrice > 0) {
          profit = Math.round(amount - (qty * costPrice));
        }

        return {
          ...item,
          costPrice,
          profit,
        };
      });

      if (totalProfit === 0) {
        const computedItemsProfit = items.reduce((sum, it) => sum + (parseFloat(it.profit) || 0), 0);
        const computedItemsCost = items.reduce((sum, it) => sum + ((parseFloat(it.quantity) || 0) * (parseFloat(it.costPrice) || 0)), 0);
        if (computedItemsProfit > 0) {
          totalProfit = computedItemsProfit;
          totalCost = computedItemsCost;
        }
      }

      return {
        ...t,
        totalCost,
        totalProfit,
        items,
      };
    });

    res.status(200).json({
      success: true,
      data: enrichedTransactions,
    });
  } catch (error) {
    next(error);
  }
};

// 3. Cập nhật thông tin đơn ghi nợ (thay toàn bộ items, ngày, ghi chú)
const updateTransaction = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;
    const { date, note, items, profitPercent, priceChangeReason, updateCustomPrice } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestError('Đơn hàng phải có ít nhất một dòng mặt hàng.');
    }

    // Kiểm tra đơn hàng có tồn tại và thuộc quyền quản lý của chủ buôn này không
    const existingTransaction = await prisma.transaction.findFirst({
      where: {
        id,
        userId,
      },
      include: {
        customer: { select: { id: true, name: true } },
        items: {
          include: {
            product: { select: { name: true, unit: true } },
          },
        },
      },
    });

    if (!existingTransaction) {
      throw new NotFoundError('Không tìm thấy đơn hàng hoặc bạn không có quyền chỉnh sửa.');
    }

    // Lấy toàn bộ sản phẩm thịt liên quan để xác thực
    const productIds = items.filter((i) => i.productId).map((i) => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, userId, isActive: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    // Lấy danh mục sản phẩm đầy đủ của chủ buôn này để so khớp khi sửa tên
    const allUserProducts = await prisma.product.findMany({
      where: { userId, isActive: true },
    });

    let calculatedTotal = 0;
    let calculatedTotalCost = 0;
    let calculatedTotalProfit = 0;
    const formattedItems = [];

    for (const item of items) {
      const { productId, productName, quantity: reqQuantity, price: reqPrice, costPrice: reqCostPrice } = item;

      if (reqQuantity === undefined || reqPrice === undefined) {
        throw new BadRequestError('Mỗi dòng mặt hàng phải chứa thông tin số lượng và giá bán.');
      }

      let finalProductId = productId;

      // Nếu có tên sản phẩm được cung cấp (cho phép sửa hoặc tạo mới trên giao diện)
      if (productName && productName.trim()) {
        const trimmedName = productName.trim();
        const normScanned = trimmedName.toLowerCase().replace(/\s+/g, '');

        // Kiểm tra xem tên mới có trùng khớp với sản phẩm hiện tại của productId hay không
        const currentProd = productId ? productMap.get(productId) : null;
        const currentProdNameNorm = currentProd ? currentProd.name.toLowerCase().replace(/\s+/g, '') : '';

        if (!currentProd || currentProdNameNorm !== normScanned) {
          // Người dùng đã sửa hoặc nhập tên sản phẩm mới! Tìm sản phẩm tương ứng trong danh sách của chủ buôn
          let matchedProduct = allUserProducts.find(
            (p) => p.name.toLowerCase().replace(/\s+/g, '') === normScanned
          );

          if (!matchedProduct) {
            // Tạo sản phẩm mới với đúng tên người dùng nhập
            matchedProduct = await prisma.product.create({
              data: {
                userId,
                createdBy: req.user.id,
                name: trimmedName,
                defaultPrice: parseFloat(reqPrice) || 0,
                costPrice: reqCostPrice !== undefined ? parseFloat(reqCostPrice) : 0,
                unit: 'kg',
              },
            });
            allUserProducts.push(matchedProduct);
            productMap.set(matchedProduct.id, matchedProduct);
          }
          finalProductId = matchedProduct.id;
        }
      }

      if (!finalProductId || !productMap.has(finalProductId)) {
        const nameToMatch = (productName || 'Tiền hàng').trim();
        const normScanned = nameToMatch.toLowerCase().replace(/\s+/g, '');

        let matchedProduct = allUserProducts.find(
          (p) => p.name.toLowerCase().replace(/\s+/g, '') === normScanned
        );

        if (matchedProduct) {
          finalProductId = matchedProduct.id;
        } else {
          let createdProd = await prisma.product.create({
            data: {
              userId,
              createdBy: req.user.id,
              name: nameToMatch,
              defaultPrice: parseFloat(reqPrice) || 0,
              costPrice: reqCostPrice !== undefined ? parseFloat(reqCostPrice) : 0,
              unit: 'kg',
            },
          });
          allUserProducts.push(createdProd);
          productMap.set(createdProd.id, createdProd);
          finalProductId = createdProd.id;
        }
      }

      const product = allUserProducts.find((p) => p.id === finalProductId);
      if (!product) {
        throw new NotFoundError(`Sản phẩm không tồn tại hoặc đã bị ẩn.`);
      }

      const quantity = parseFloat(reqQuantity);
      const price = parseFloat(reqPrice);
      const costPrice = reqCostPrice !== undefined ? parseFloat(reqCostPrice) : (parseFloat(product.costPrice) || 0);

      if (quantity <= 0 || price < 0) {
        throw new BadRequestError('Số lượng phải > 0 và đơn giá không được âm.');
      }

      const amount = Math.round(quantity * price);
      const itemCost = Math.round(quantity * costPrice);
      const itemProfit = amount - itemCost;

      calculatedTotal += amount;
      calculatedTotalCost += itemCost;
      calculatedTotalProfit += itemProfit;

      formattedItems.push({ productId: finalProductId, quantity, price, costPrice, amount, profit: itemProfit });
    }

    // Xử lý % lợi nhuận nếu có
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

    // Cập nhật trong Prisma Transaction: xoá items cũ, tạo items mới
    const updated = await prisma.$transaction(async (tx) => {
      // Xóa toàn bộ items cũ của đơn hàng này
      await tx.transactionItem.deleteMany({ where: { transactionId: id } });

      // Cập nhật transaction và tạo items mới
      const transaction = await tx.transaction.update({
        where: { id },
        data: {
          date: date ? new Date(date) : existingTransaction.date,
          note: note !== undefined ? (note || null) : existingTransaction.note,
          totalAmount: calculatedTotal,
          profitPercent: finalProfitPercent,
          totalCost: finalTotalCost,
          totalProfit: finalTotalProfit,
          items: { create: formattedItems },
        },
        include: {
          items: {
            include: {
              product: { select: { name: true, unit: true, defaultPrice: true, costPrice: true } },
            },
          },
        },
      });

      // Đồng bộ lại ngày của các ảnh hóa đơn đính kèm đơn nợ nếu ngày giao dịch thay đổi
      if (date) {
        await tx.transactionInvoice.updateMany({
          where: { transactionId: id },
          data: { date: new Date(date) },
        });
      }

      // Cập nhật hoặc lưu mới đơn giá bán thực tế của loại thịt cho khách hàng này (kèm lý do đổi giá nếu có, nếu updateCustomPrice === false thì chỉ áp dụng cho đơn nợ này)
      if (updateCustomPrice !== false) {
        const customerId = existingTransaction.customerId;
        for (const item of formattedItems) {
          await tx.customerProductPrice.upsert({
            where: {
              customerId_productId: {
                customerId,
                productId: item.productId,
              },
            },
            update: {
              price: item.price,
              ...(priceChangeReason !== undefined ? { changeReason: priceChangeReason?.trim() || null } : {}),
            },
            create: {
              customerId,
              productId: item.productId,
              price: item.price,
              changeReason: priceChangeReason?.trim() || null,
            },
          });
        }
      }

      return transaction;
    });

    const customerName = existingTransaction.customer?.name || 'ẩn';

    // Xây dựng chuỗi tóm tắt món trước và sau khi sửa
    const oldItemsSummary = (existingTransaction.items || [])
      .map((it) => `${it.product?.name || 'Món'}: ${it.quantity}${it.product?.unit || 'kg'} x ${Number(it.price).toLocaleString('vi-VN')}đ`)
      .join(', ');
    const newItemsSummary = (updated.items || [])
      .map((it) => `${it.product?.name || 'Món'}: ${it.quantity}${it.product?.unit || 'kg'} x ${Number(it.price).toLocaleString('vi-VN')}đ`)
      .join(', ');

    const oldTotalStr = `${Number(existingTransaction.totalAmount).toLocaleString('vi-VN')}đ`;
    const newTotalStr = `${Number(calculatedTotal).toLocaleString('vi-VN')}đ`;

    const oldDateStr = existingTransaction.date
      ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(existingTransaction.date))
      : '';
    const newDateStr = date
      ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(date))
      : oldDateStr;

    const extraChanges = [];
    if (date && oldDateStr !== newDateStr) {
      extraChanges.push(`Đổi ngày: ${oldDateStr} ➔ ${newDateStr}`);
    }
    if (note !== undefined && (note || '') !== (existingTransaction.note || '')) {
      extraChanges.push(`Ghi chú: "${existingTransaction.note || 'Không'}" ➔ "${note || 'Không'}"`);
    }
    const extraInfoStr = extraChanges.length > 0 ? ` (${extraChanges.join(' | ')})` : '';

    const dateDisplay = oldDateStr ? ` ngày ${oldDateStr}` : '';
    const logDetail = `Cập nhật đơn nợ${dateDisplay} của khách hàng ${customerName}${extraInfoStr}:\n• Trước: ${oldTotalStr} [${oldItemsSummary || 'Trống'}]\n• Sau: ${newTotalStr} [${newItemsSummary || 'Trống'}]`;

    await logActivity(
      userId,
      'UPDATE_TRANSACTION',
      logDetail
    );
    notifyCustomerUpdate(userId, 'UPDATE_TRANSACTION', { customerId: existingTransaction.customerId, transactionId: id });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

// 4. Xóa giao dịch ghi nợ thịt (Transaction) theo ID
const deleteTransaction = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;

    // Kiểm tra giao dịch có tồn tại và thuộc chủ buôn này không
    const existing = await prisma.transaction.findFirst({
      where: { id, userId },
      include: {
        items: {
          include: {
            product: { select: { name: true, unit: true } },
          },
        },
      },
    });
    if (!existing) {
      throw new NotFoundError('Giao dịch không tồn tại hoặc không thuộc quyền quản lý của bạn.');
    }

    const customer = await prisma.customer.findUnique({
      where: { id: existing.customerId },
    });

    // Kiểm tra bảo vệ dữ liệu chéo: Nhân viên chỉ được xóa dữ liệu do chính mình tạo. Chủ Workspace và Admin tối cao có toàn quyền.
    const actorId = req.user.id;
    const actorIsAdmin = req.user.isAdmin === true;
    if (!actorIsAdmin && existing.createdBy !== actorId && actorId !== existing.userId) {
      throw new ForbiddenError('Tài khoản của bạn không có quyền xóa dữ liệu do người khác tạo.');
    }

    // Thực hiện xóa giao dịch (bảng transaction_items tự động xóa theo cascade)
    await prisma.transaction.delete({
      where: { id },
    });

    const transDateStr = existing.date
      ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(existing.date))
      : '';
    const dateDisplay = transDateStr ? ` ngày ${transDateStr}` : '';
    const itemsSummary = (existing.items || [])
      .map((it) => `${it.product?.name || 'Món'}: ${it.quantity}${it.product?.unit || 'kg'} x ${Number(it.price).toLocaleString('vi-VN')}đ`)
      .join(', ');
    const itemsStr = itemsSummary ? ` [${itemsSummary}]` : '';

    await logActivity(
      userId,
      'DELETE_TRANSACTION',
      `Xóa đơn nợ${dateDisplay} của khách hàng ${customer?.name || 'ẩn'}: Số tiền ${Number(existing.totalAmount).toLocaleString('vi-VN')}đ${itemsStr}`
    );
    notifyCustomerUpdate(userId, 'DELETE_TRANSACTION', { customerId: existing.customerId, transactionId: id });

    res.status(200).json({
      success: true,
      message: 'Xóa giao dịch thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 5. Tải lên hàng loạt ảnh hóa đơn, lưu đĩa và tự động đính kèm vào đơn công nợ trong ngày của từng khách hàng
const uploadBatchInvoices = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { items } = req.body; // Mảng: [{ customerId, date, imageBase64, note }]

    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestError('Vui lòng gửi danh sách ảnh hóa đơn hợp lệ.');
    }

    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');

    // Đường dẫn thư mục lưu trữ file ảnh hóa đơn uploads/invoices
    const uploadsDir = path.join(__dirname, '../../uploads/invoices');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Xử lý song song các tệp trong lô để tối ưu thời gian tải lên Cloudinary
    const uploadPromises = items.map(async (item, index) => {
      const { customerId, date, imageBase64, note, transactionId, paymentId } = item;

      if (!customerId) {
        throw new BadRequestError(`Tệp số ${index + 1} chưa được chọn khách hàng.`);
      }
      if (!imageBase64) {
        throw new BadRequestError(`Tệp số ${index + 1} không có dữ liệu hình ảnh hoặc video.`);
      }

      // Xác thực khách hàng tồn tại trong danh bạ
      const customer = await prisma.customer.findFirst({
        where: { id: customerId, userId, isActive: true },
      });
      if (!customer) {
        throw new NotFoundError(`Không tìm thấy khách hàng cho tệp số ${index + 1}.`);
      }

      // Nhận diện loại tệp: Video hoặc Hình ảnh
      let fileExt = 'jpg';
      let isVideo = false;
      let mimeType = 'image/jpeg';
      let cleanBase64 = imageBase64;

      if (typeof imageBase64 === 'string') {
        if (imageBase64.startsWith('data:video/')) {
          isVideo = true;
          const match = imageBase64.match(/^data:video\/([a-zA-Z0-9+.\-_]+);base64,(.+)$/);
          if (match && match.length === 3) {
            const subType = match[1].toLowerCase();
            fileExt = subType === 'quicktime' ? 'mov' : subType.split('+')[0];
            mimeType = `video/${match[1]}`;
            cleanBase64 = match[2];
          } else {
            fileExt = 'mp4';
            mimeType = 'video/mp4';
            cleanBase64 = imageBase64.split(',')[1] || imageBase64;
          }
        } else if (imageBase64.startsWith('data:image/')) {
          const match = imageBase64.match(/^data:image\/([a-zA-Z0-9+.\-_]+);base64,(.+)$/);
          if (match && match.length === 3) {
            const subType = match[1].toLowerCase();
            fileExt = subType === 'jpeg' ? 'jpg' : subType;
            mimeType = `image/${match[1]}`;
            cleanBase64 = match[2];
          } else {
            fileExt = 'jpg';
            mimeType = 'image/jpeg';
            cleanBase64 = imageBase64.split(',')[1] || imageBase64;
          }
        } else if (item.mediaType === 'video') {
          isVideo = true;
          fileExt = item.fileExt || 'mp4';
          mimeType = `video/${fileExt}`;
        }
      }

      // Lưu file dự phòng vào thư mục máy chủ uploads/invoices
      const prefix = isVideo ? 'vid' : 'inv';
      const fileName = `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${fileExt}`;
      const filePath = path.join(uploadsDir, fileName);
      const buffer = Buffer.from(cleanBase64, 'base64');
      fs.writeFileSync(filePath, buffer);

      let imageUrl = `/uploads/invoices/${fileName}`;

      // Nếu đã cấu hình Cloudinary, tải ảnh/video lên đám mây và lưu link Cloudinary vĩnh viễn (res.cloudinary.com)
      let cloudinaryFailed = false;
      if (isCloudinaryConfigured()) {
        try {
          const dataUri = `data:${mimeType};base64,${cleanBase64}`;
          const uploadRes = await uploadToCloudinary(dataUri, {
            folder: isVideo ? 'meat_invoices/videos' : 'meat_invoices',
            resource_type: isVideo ? 'video' : 'image',
          });
          if (uploadRes && uploadRes.secure_url) {
            imageUrl = uploadRes.secure_url;
          }
        } catch (cloudErr) {
          console.warn('[UPLOAD] Lỗi tải lên Cloudinary, giữ đường dẫn file máy chủ tạm:', cloudErr.message);
          cloudinaryFailed = true;
        }
      }

      // Xử lý ngày hóa đơn
      let invoiceDate = date ? new Date(date) : new Date();
      if (isNaN(invoiceDate.getTime())) {
        invoiceDate = new Date();
      }

      // Tính khoảng thời gian 00:00:00 - 23:59:59 của ngày theo giờ Việt Nam
      const dateVN = new Date(invoiceDate.getTime() + 7 * 60 * 60 * 1000);
      const year = dateVN.getUTCFullYear();
      const monthVal = dateVN.getUTCMonth();
      const dayVal = dateVN.getUTCDate();

      const startUTC = new Date(Date.UTC(year, monthVal, dayVal, 0, 0, 0, 0) - 7 * 60 * 60 * 1000);
      const endUTC = new Date(Date.UTC(year, monthVal, dayVal, 23, 59, 59, 999) - 7 * 60 * 60 * 1000);

      // Tìm đơn nợ Transaction hoặc đơn trả hàng Payment của khách này để đính kèm
      let targetPaymentId = paymentId || null;
      let existingTransaction = null;

      if (transactionId) {
        existingTransaction = await prisma.transaction.findFirst({
          where: {
            id: transactionId,
            userId,
          },
        });
        if (!existingTransaction && !targetPaymentId) {
          const checkPayment = await prisma.payment.findFirst({
            where: { id: transactionId, customer: { userId } },
          });
          if (checkPayment) {
            targetPaymentId = checkPayment.id;
          }
        }
      }

      if (!existingTransaction && !targetPaymentId) {
        existingTransaction = await prisma.transaction.findFirst({
          where: {
            userId,
            customerId,
            date: { gte: startUTC, lte: endUTC },
          },
          orderBy: { createdAt: 'desc' },
        });

        // Nếu không có đơn nợ nhưng có đơn trả hàng / thanh toán của khách trong ngày
        if (!existingTransaction) {
          const existingPayment = await prisma.payment.findFirst({
            where: {
              customerId,
              customer: { userId },
              paidAt: { gte: startUTC, lte: endUTC },
            },
            orderBy: { createdAt: 'desc' },
          });
          if (existingPayment) {
            targetPaymentId = existingPayment.id;
          }
        }
      }

      let finalNote = note || null;
      if (targetPaymentId) {
        finalNote = `[paymentId:${targetPaymentId}] ` + (note ? `${note}` : 'Đơn trả hàng');
      }

      const invoiceRecord = await prisma.transactionInvoice.create({
        data: {
          userId,
          customerId,
          date: invoiceDate,
          imageUrl,
          note: finalNote,
          transactionId: existingTransaction ? existingTransaction.id : null,
        },
        include: {
          customer: { select: { id: true, name: true } },
          transaction: { select: { id: true, totalAmount: true, date: true } },
        },
      });

      return invoiceRecord;
    });

    const savedInvoices = await Promise.all(uploadPromises);

    // Nếu có hóa đơn nào Cloudinary thất bại lúc upload ban đầu → trigger retry ngay trong background
    // để tránh phụ thuộc hoàn toàn vào scheduler 3 phút (file có thể mất nếu server restart trước đó)
    setImmediate(async () => {
      const { recoverStuckSubmissions } = require('../schedulers/staffSubmissionRecoveryScheduler');
      try {
        await recoverStuckSubmissions();
      } catch (_) {}
    });

    // Ghi log nhật ký hoạt động
    await logActivity(
      userId,
      'UPLOAD_INVOICE_IMAGES',
      `Tải lên ${savedInvoices.length} ảnh hóa đơn đính kèm đơn nợ khách hàng.`
    );

    // Thông báo sự kiện socket cập nhật danh sách
    notifyCustomerUpdate(userId, 'INVOICES_UPLOADED', {
      count: savedInvoices.length,
    });

    return res.status(201).json({
      success: true,
      message: `Đã lưu thành công ${savedInvoices.length} ảnh hóa đơn.`,
      data: savedInvoices,
    });
  } catch (error) {
    next(error);
  }
};

// 9. Xóa một ảnh hóa đơn đã lưu
const deleteInvoiceImage = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;

    const invoice = await prisma.transactionInvoice.findFirst({
      where: { id, userId },
      include: { customer: { select: { name: true } } },
    });

    if (!invoice) {
      throw new NotFoundError('Không tìm thấy ảnh hóa đơn hoặc bạn không có quyền xóa.');
    }

    // Xóa file vật lý trên ổ đĩa máy chủ (nếu có)
    const fs = require('fs');
    const path = require('path');
    try {
      const filePath = path.join(__dirname, '../../', invoice.imageUrl);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (_) {}

    // Xóa file trên đám mây Cloudinary nếu được lưu trữ qua Cloudinary
    if (isCloudinaryConfigured() && invoice.imageUrl && invoice.imageUrl.includes('res.cloudinary.com')) {
      try {
        const urlParts = invoice.imageUrl.split('/upload/');
        if (urlParts.length === 2) {
          const pathAfterUpload = urlParts[1].replace(/^v\d+\//, '');
          const lastDotIdx = pathAfterUpload.lastIndexOf('.');
          const publicId = lastDotIdx !== -1 ? pathAfterUpload.substring(0, lastDotIdx) : pathAfterUpload;
          const isVideo = invoice.imageUrl.includes('/video/') || /\.(mp4|mov|webm|m4v)($|\?)/i.test(invoice.imageUrl);
          await deleteFromCloudinary(publicId, { resource_type: isVideo ? 'video' : 'image' });
        }
      } catch (cErr) {
        console.warn('[CLOUDINARY DELETE ERROR]', cErr.message);
      }
    }

    // Xóa bản ghi trong database
    await prisma.transactionInvoice.delete({
      where: { id },
    });

    await logActivity(
      userId,
      'DELETE_INVOICE_IMAGE',
      `Xóa ảnh hóa đơn của khách hàng ${invoice.customer?.name || 'ẩn'}`
    );

    notifyCustomerUpdate(userId, 'INVOICE_DELETED', {
      invoiceId: id,
      customerId: invoice.customerId,
      transactionId: invoice.transactionId,
    });

    return res.status(200).json({
      success: true,
      message: 'Đã xóa ảnh hóa đơn thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 10. Lấy danh sách ảnh hóa đơn đã lưu của chủ buôn (hỗ trợ lọc theo khách hàng, khoảng ngày, tìm kiếm)
const getInvoiceImages = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { customerId, fromDate, toDate, search } = req.query;

    const where = {
      userId,
    };

    if (customerId) {
      where.customerId = customerId;
    }

    const parseParamDate = (str, isEnd = false) => {
      if (!str) return null;
      if (str.includes('/')) {
        const parts = str.split('/');
        if (parts.length === 3) {
          const [d, m, y] = parts.map(Number);
          return new Date(y, m - 1, d, isEnd ? 23 : 0, isEnd ? 59 : 0, isEnd ? 59 : 0, isEnd ? 999 : 0);
        }
      }
      const dt = new Date(str);
      if (!isNaN(dt.getTime())) {
        if (isEnd) dt.setHours(23, 59, 59, 999);
        else dt.setHours(0, 0, 0, 0);
        return dt;
      }
      return null;
    };

    if (fromDate || toDate) {
      where.date = {};
      const fromD = parseParamDate(fromDate, false);
      if (fromD) {
        where.date.gte = fromD;
      }
      const toD = parseParamDate(toDate, true);
      if (toD) {
        where.date.lte = toD;
      }
    }

    if (search && search.trim()) {
      where.customer = {
        name: {
          contains: search.trim(),
          mode: 'insensitive',
        },
      };
    }

    const invoices = await prisma.transactionInvoice.findMany({
      where,
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
        transaction: {
          select: {
            id: true,
            totalAmount: true,
          },
        },
      },
      orderBy: [
        { date: 'desc' },
        { createdAt: 'desc' },
      ],
    });

    return res.status(200).json({
      success: true,
      data: invoices,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Kiểm tra danh sách cặp (customerId, date) — có công nợ ghi nợ nào trong ngày đó không
 * POST /api/v1/transactions/check-debt-existence
 * Body: { pairs: [{ customerId, date }] }
 * Response: { data: { "customerId_YYYY-MM-DD": true/false, ... } }
 */
const checkDebtExistence = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { pairs } = req.body;

    if (!Array.isArray(pairs) || pairs.length === 0) {
      return res.status(400).json({ success: false, message: 'Danh sách pairs không hợp lệ.' });
    }

    const result = {};
    const invoiceCounts = {};

    for (const pair of pairs) {
      const { customerId, date, dateStr } = pair;
      if (!customerId) continue;

      // Xác định khoảng thời gian theo chuẩn múi giờ Việt Nam (UTC+7)
      let dayStart;
      let dayEnd;
      let effectiveDateStr = dateStr;

      if (dateStr && typeof dateStr === 'string' && dateStr.includes('/')) {
        const parts = dateStr.trim().split('/');
        const day = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10);
        const year = parseInt(parts[2], 10);
        // Bắt đầu ngày theo giờ VN (00:00:00 UTC+7 = 17:00:00 UTC ngày hôm trước)
        dayStart = new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - 7 * 3600 * 1000);
        // Kết thúc ngày theo giờ VN (23:59:59.999 UTC+7 = 16:59:59.999 UTC)
        dayEnd = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999) - 7 * 3600 * 1000);
      } else if (date) {
        const d = new Date(date);
        const dateVN = new Date(d.getTime() + 7 * 60 * 60 * 1000);
        const year = dateVN.getUTCFullYear();
        const monthVal = dateVN.getUTCMonth();
        const dayVal = dateVN.getUTCDate();
        dayStart = new Date(Date.UTC(year, monthVal, dayVal, 0, 0, 0, 0) - 7 * 60 * 60 * 1000);
        dayEnd = new Date(Date.UTC(year, monthVal, dayVal, 23, 59, 59, 999) - 7 * 60 * 60 * 1000);
      } else {
        continue;
      }

      // Các key định danh để đảm bảo Frontend luôn tìm thấy dù tra cứu theo dateStr hay isoDate
      const isoKey = `${customerId}_${dayStart.toISOString().split('T')[0]}`;
      const pairKey = effectiveDateStr ? `${customerId}_${effectiveDateStr}` : null;

      // Kiểm tra có bất kỳ giao dịch ghi nợ (Transaction) hoặc đơn trả hàng/thanh toán (Payment) nào của khách trong ngày đó không
      const [transCount, payCount] = await Promise.all([
        prisma.transaction.count({
          where: {
            userId,
            customerId,
            date: {
              gte: dayStart,
              lte: dayEnd,
            },
          },
        }),
        prisma.payment.count({
          where: {
            customerId,
            customer: { userId },
            paidAt: {
              gte: dayStart,
              lte: dayEnd,
            },
          },
        }),
      ]);

      const hasDebt = (transCount + payCount) > 0;
      result[isoKey] = hasDebt;
      if (pairKey) result[pairKey] = hasDebt;

      // Đếm số lượng ảnh/video hóa đơn đã lưu trong ngày của khách hàng này để kiểm tra trùng lặp
      const invCount = await prisma.transactionInvoice.count({
        where: {
          userId,
          customerId,
          date: {
            gte: dayStart,
            lte: dayEnd,
          },
        },
      });

      invoiceCounts[isoKey] = invCount;
      if (pairKey) invoiceCounts[pairKey] = invCount;
    }

    return res.status(200).json({ success: true, data: result, invoiceCounts });
  } catch (error) {
    next(error);
  }
};

/**
 * Đồng bộ ảnh/video hóa đơn TransactionInvoice lên Cloudinary khi còn lưu tạm ở /uploads/
 * POST /invoices/:id/sync-cloud
 */
const syncCloudInvoice = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;
    const fs = require('fs');
    const path = require('path');

    const invoice = await prisma.transactionInvoice.findFirst({
      where: { id, userId },
    });

    if (!invoice) {
      throw new NotFoundError('Không tìm thấy ảnh hóa đơn hoặc bạn không có quyền truy cập.');
    }

    // Nếu đã có link Cloudinary hoặc HTTP/HTTPS rồi thì trả về luôn
    if (invoice.imageUrl && (invoice.imageUrl.startsWith('http://') || invoice.imageUrl.startsWith('https://'))) {
      return res.json({
        success: true,
        message: 'Tệp đã được lưu trữ trên đám mây.',
        data: { id: invoice.id, imageUrl: invoice.imageUrl },
      });
    }

    // Nếu vẫn còn link /uploads/ cục bộ
    if (invoice.imageUrl && invoice.imageUrl.startsWith('/uploads/')) {
      const relativePath = invoice.imageUrl.replace(/^\//, '');
      const diskPath = path.join(__dirname, '../../', relativePath);

      if (fs.existsSync(diskPath)) {
        const isVideo = /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(diskPath);
        const uploadRes = await uploadToCloudinary(diskPath, {
          filePath: diskPath,
          folder: 'meat_invoices/videos',
          resource_type: isVideo ? 'video' : 'image',
        });

        if (uploadRes && uploadRes.secure_url) {
          const cloudUrl = uploadRes.secure_url;
          // Cập nhật TransactionInvoice sang URL Cloudinary
          await prisma.transactionInvoice.update({
            where: { id: invoice.id },
            data: { imageUrl: cloudUrl },
          });

          // Đồng bộ ngược sang StaffSubmission nếu có liên kết
          await prisma.staffSubmission.updateMany({
            where: { fileUrl: invoice.imageUrl },
            data: { fileUrl: cloudUrl },
          });

          return res.json({
            success: true,
            message: 'Đồng bộ tệp lên đám mây thành công!',
            data: { id: invoice.id, imageUrl: cloudUrl },
          });
        }
      }

      // File không còn trên đĩa (do server restart/redeploy)
      return res.json({
        success: false,
        isMissingFile: true,
        message: 'Tệp video tạm trên máy chủ đã hết hạn. Dữ liệu đơn nợ vẫn còn nguyên vẹn trong hệ thống.',
        data: { id: invoice.id, imageUrl: invoice.imageUrl },
      });
    }

    return res.json({
      success: true,
      data: { id: invoice.id, imageUrl: invoice.imageUrl },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createTransaction,
  getTransactions,
  updateTransaction,
  deleteTransaction,
  uploadBatchInvoices,
  deleteInvoiceImage,
  getInvoiceImages,
  checkDebtExistence,
  syncCloudInvoice,
};
