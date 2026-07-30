// meat-management-be/src/controllers/store.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, AppError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');
const crypto = require('crypto');

// Hàm hỗ trợ so khớp tên món ăn hoặc chuyển thành "Món lẻ" ảo
const matchOrCreateStoreProducts = async (userId, items) => {
  const matched = [];

  // Lấy toàn bộ thực đơn của chủ quán
  const userProducts = await prisma.product.findMany({
    where: { userId, isActive: true, type: 'store' },
  });

  const productMap = new Map();
  userProducts.forEach((p) => {
    productMap.set(p.name.toLowerCase().trim(), p);
  });

  // Tìm sản phẩm "Món lẻ"
  let monLeProduct = userProducts.find(
    (p) => p.name === 'Món lẻ' || p.name.toLowerCase().trim() === 'món lẻ'
  );

  if (!monLeProduct) {
    monLeProduct = await prisma.product.create({
      data: {
        userId,
        name: 'Món lẻ',
        defaultPrice: 0,
        unit: 'phần',
        type: 'store',
        isActive: true,
      },
    });
    userProducts.push(monLeProduct);
  }

  for (const item of items) {
    const rawName = item.name || item.productName || 'Món lẻ';
    const cleanName = rawName.toLowerCase().trim();

    let product = productMap.get(cleanName);

    // Thử so khớp bán phần
    if (!product) {
      product = userProducts.find((p) => {
        const normP = p.name.toLowerCase().trim();
        return cleanName.includes(normP) || normP.includes(cleanName);
      });
    }

    // Nếu vẫn không tìm thấy, gán vào "Món lẻ"
    if (!product) {
      product = monLeProduct;
    }

    const qty = parseFloat(item.quantity) || 1;
    const prc = parseInt(item.price) || 0;

    matched.push({
      product,
      quantity: qty,
      price: prc,
      amount: parseInt(item.amount) || Math.round(qty * prc),
    });
  }

  return matched;
};

// 1. Tạo hàng loạt bàn ăn trong một lần gửi (Bulk Create Tables)
const createTablesBulk = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { prefix, count } = req.body;
    const tableCount = parseInt(count);

    if (!prefix || isNaN(tableCount) || tableCount <= 0) {
      throw new BadRequestError('Tiền tố bàn và số lượng bàn (lớn hơn 0) là thông tin bắt buộc.');
    }

    const cleanPrefix = prefix.trim();
    const tablesData = [];
    for (let i = 1; i <= tableCount; i++) {
      tablesData.push({
        id: crypto.randomUUID(),
        userId,
        name: `${cleanPrefix} ${i}`,
        type: 'store',
        isActive: true,
        isBadDebt: false,
        manualDebt: 0,
      });
    }

    const namesToCheck = tablesData.map((t) => t.name);
    const existingTables = await prisma.customer.findMany({
      where: {
        userId,
        name: { in: namesToCheck },
        isActive: true,
        type: 'store',
      },
    });

    const existingNames = new Set(existingTables.map((t) => t.name));
    const filteredTablesData = tablesData.filter((t) => !existingNames.has(t.name));

    if (filteredTablesData.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'Tất cả các bàn trong dải số lượng này đã tồn tại.',
        data: [],
      });
    }

    const result = await prisma.customer.createMany({
      data: filteredTablesData,
    });

    await logActivity(
      userId,
      'CREATE_TABLES_BULK',
      `Tạo hàng loạt ${filteredTablesData.length} bàn ăn mới với tiền tố "${prefix}"`
    );

    res.status(201).json({
      success: true,
      message: `Đã tạo thành công ${filteredTablesData.length} bàn ăn mới.`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// 2. Tính tổng doanh thu từ tất cả các đơn hàng cửa hàng (Tổng doanh thu)
const getStoreTotalRevenue = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const aggregations = await prisma.transaction.aggregate({
      _sum: {
        totalAmount: true,
      },
      where: {
        userId,
        type: 'store',
      },
    });

    const total = parseFloat(aggregations._sum.totalAmount || 0);

    res.status(200).json({
      success: true,
      data: {
        totalRevenue: total,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 3. Tính doanh thu của cửa hàng phân tách theo từng ngày (Doanh thu theo ngày)
const getStoreDailyRevenue = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        type: 'store',
      },
      select: {
        date: true,
        totalAmount: true,
      },
      orderBy: {
        date: 'desc',
      },
    });

    const dailyMap = {};
    transactions.forEach((tx) => {
      const dateKey = tx.date.toISOString().split('T')[0];
      const amount = parseFloat(tx.totalAmount || 0);
      dailyMap[dateKey] = (dailyMap[dateKey] || 0) + amount;
    });

    const data = Object.keys(dailyMap)
      .map((dateKey) => ({
        dateKey,
        amount: dailyMap[dateKey],
      }))
      .sort((a, b) => b.dateKey.localeCompare(a.dateKey));

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
};

// 4. Lấy danh sách bàn ăn (đọc từ bảng Customer với type = 'store')
const getTables = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const tables = await prisma.customer.findMany({
      where: {
        userId,
        isActive: true,
        type: 'store',
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
      orderBy: {
        name: 'asc',
      },
    });

    // Tính toán số tiền nợ/tiền chưa thanh toán của bàn ăn
    const tablesWithDebt = tables.map((t) => {
      const totalPurchase = t.transactions.reduce((sum, tx) => sum + parseFloat(tx.totalAmount || 0), 0);
      const totalPaid = t.payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
      const debt = totalPurchase - totalPaid + parseFloat(t.manualDebt || 0);

      const { transactions, payments, ...rest } = t;
      return {
        ...rest,
        debt,
      };
    });

    // Sắp xếp tự nhiên (Natural Sort) để các bàn được đánh số xếp đúng thứ tự số học (Bàn 2 đứng trước Bàn 10)
    tablesWithDebt.sort((a, b) => {
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    res.status(200).json({
      success: true,
      data: tablesWithDebt,
    });
  } catch (error) {
    next(error);
  }
};

// 5. Lấy thông tin chi tiết một bàn ăn
const getTableById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const table = await prisma.customer.findFirst({
      where: {
        id,
        userId,
        isActive: true,
        type: 'store',
      },
    });

    if (!table) {
      throw new NotFoundError('Bàn ăn không tồn tại hoặc không thuộc quyền quản lý của bạn.');
    }

    res.status(200).json({
      success: true,
      data: table,
    });
  } catch (error) {
    next(error);
  }
};

// 6. Tạo một bàn ăn mới đơn lẻ
const createTable = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { name, phone, address, note } = req.body;

    if (!name || !name.trim()) {
      throw new BadRequestError('Tên bàn ăn là bắt buộc.');
    }

    const existing = await prisma.customer.findFirst({
      where: {
        userId,
        name: name.trim(),
        isActive: true,
        type: 'store',
      },
    });

    if (existing) {
      throw new BadRequestError('Bàn ăn này đã tồn tại.');
    }

    const table = await prisma.customer.create({
      data: {
        userId,
        name: name.trim(),
        phone: phone?.trim() || null,
        address: address?.trim() || null,
        note: note?.trim() || null,
        type: 'store',
      },
    });

    await logActivity(userId, 'CREATE_TABLE', `Tạo bàn ăn mới: ${table.name}`);

    res.status(201).json({
      success: true,
      data: table,
    });
  } catch (error) {
    next(error);
  }
};

// 7. Cập nhật thông tin bàn ăn
const updateTable = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { name, phone, address, note } = req.body;

    const table = await prisma.customer.findFirst({
      where: {
        id,
        userId,
        isActive: true,
        type: 'store',
      },
    });

    if (!table) {
      throw new NotFoundError('Bàn ăn không tồn tại.');
    }

    if (name && name.trim() !== table.name) {
      const existing = await prisma.customer.findFirst({
        where: {
          userId,
          name: name.trim(),
          isActive: true,
          type: 'store',
          id: { not: id },
        },
      });
      if (existing) {
        throw new BadRequestError('Tên bàn ăn này đã tồn tại.');
      }
    }

    const updatedTable = await prisma.customer.update({
      where: { id },
      data: {
        name: name !== undefined ? name.trim() : undefined,
        phone: phone !== undefined ? phone.trim() : undefined,
        address: address !== undefined ? address.trim() : undefined,
        note: note !== undefined ? note.trim() : undefined,
      },
    });

    await logActivity(userId, 'UPDATE_TABLE', `Cập nhật bàn ăn: ${table.name} thành ${updatedTable.name}`);

    res.status(200).json({
      success: true,
      data: updatedTable,
    });
  } catch (error) {
    next(error);
  }
};

// 8. Xóa bàn ăn (Xóa mềm bằng isActive)
const deleteTable = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const table = await prisma.customer.findFirst({
      where: {
        id,
        userId,
        isActive: true,
        type: 'store',
      },
    });

    if (!table) {
      throw new NotFoundError('Bàn ăn không tồn tại.');
    }

    await prisma.customer.update({
      where: { id },
      data: { isActive: false },
    });

    await logActivity(userId, 'DELETE_TABLE', `Xóa bàn ăn: ${table.name}`);

    res.status(200).json({
      success: true,
      message: 'Xóa bàn ăn thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 9. Lấy danh sách thực đơn (Sản phẩm với type = 'store')
const getProducts = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const products = await prisma.product.findMany({
      where: {
        userId,
        isActive: true,
        type: 'store',
      },
      orderBy: {
        name: 'asc',
      },
    });

    res.status(200).json({
      success: true,
      data: products,
    });
  } catch (error) {
    next(error);
  }
};

// 10. Tạo món ăn thực đơn mới
const createProduct = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { name, defaultPrice, unit } = req.body;

    if (!name || !name.trim()) {
      throw new BadRequestError('Tên món ăn là bắt buộc.');
    }

    const price = parseFloat(defaultPrice);
    if (isNaN(price) || price < 0) {
      throw new BadRequestError('Đơn giá không hợp lệ.');
    }

    const product = await prisma.product.create({
      data: {
        userId,
        name: name.trim(),
        defaultPrice: price,
        unit: unit?.trim() || 'phần',
        type: 'store',
        isActive: true,
      },
    });

    await logActivity(userId, 'CREATE_STORE_PRODUCT', `Thêm món ăn: ${product.name}`);

    res.status(201).json({
      success: true,
      data: product,
    });
  } catch (error) {
    next(error);
  }
};

// 11. Cập nhật món ăn thực đơn
const updateProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { name, defaultPrice, unit, isActive } = req.body;

    const product = await prisma.product.findFirst({
      where: {
        id,
        userId,
        type: 'store',
      },
    });

    if (!product) {
      throw new NotFoundError('Món ăn không tồn tại.');
    }

    const price = defaultPrice !== undefined ? parseFloat(defaultPrice) : undefined;
    if (price !== undefined && (isNaN(price) || price < 0)) {
      throw new BadRequestError('Đơn giá không hợp lệ.');
    }

    const updatedProduct = await prisma.product.update({
      where: { id },
      data: {
        name: name !== undefined ? name.trim() : undefined,
        defaultPrice: price,
        unit: unit !== undefined ? unit.trim() : undefined,
        isActive: isActive !== undefined ? isActive : undefined,
      },
    });

    await logActivity(userId, 'UPDATE_STORE_PRODUCT', `Cập nhật món ăn: ${product.name}`);

    res.status(200).json({
      success: true,
      data: updatedProduct,
    });
  } catch (error) {
    next(error);
  }
};

// 12. Xóa món ăn thực đơn
const deleteProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const product = await prisma.product.findFirst({
      where: {
        id,
        userId,
        type: 'store',
      },
    });

    if (!product) {
      throw new NotFoundError('Món ăn không tồn tại.');
    }

    await prisma.product.update({
      where: { id },
      data: { isActive: false },
    });

    await logActivity(userId, 'DELETE_STORE_PRODUCT', `Xóa món ăn: ${product.name}`);

    res.status(200).json({
      success: true,
      message: 'Xóa món ăn thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 13. Lấy danh sách giao dịch/hóa đơn gọi món
const getTransactions = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { customerId } = req.query;

    const whereClause = {
      userId,
      type: 'store',
    };

    if (customerId) {
      whereClause.customerId = customerId;
    }

    const transactions = await prisma.transaction.findMany({
      where: whereClause,
      include: {
        customer: {
          select: { name: true },
        },
        items: {
          include: {
            product: {
              select: { name: true, unit: true },
            },
          },
        },
      },
      orderBy: {
        date: 'desc',
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

// 14. Tạo hóa đơn gọi món mới cho bàn ăn
const createTransaction = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { customerId, date, note, items } = req.body;

    if (!customerId || !items || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestError('Bàn ăn và danh sách món ăn gọi là bắt buộc.');
    }

    const table = await prisma.customer.findFirst({
      where: { id: customerId, userId, isActive: true, type: 'store' },
    });
    if (!table) {
      throw new NotFoundError('Bàn ăn không tồn tại hoặc đã bị ẩn.');
    }

    // Lấy toàn bộ thực đơn để khớp sản phẩm
    const allUserProducts = await prisma.product.findMany({
      where: { userId, isActive: true, type: 'store' },
    });
    const productMap = new Map(allUserProducts.map((p) => [p.id, p]));

    // Tìm sản phẩm "Món lẻ" hoặc tự động tạo nếu thiếu
    let monLeProduct = allUserProducts.find(
      (p) => p.name === 'Món lẻ' || p.name.toLowerCase().trim() === 'món lẻ'
    );
    if (!monLeProduct) {
      monLeProduct = await prisma.product.create({
        data: {
          userId,
          name: 'Món lẻ',
          defaultPrice: 0,
          unit: 'phần',
          type: 'store',
          isActive: true,
        },
      });
      allUserProducts.push(monLeProduct);
    }

    let calculatedTotal = 0;
    const formattedItems = [];

    for (const item of items) {
      const { productId, productName, quantity: reqQuantity, price: reqPrice } = item;

      if (reqQuantity === undefined || reqPrice === undefined) {
        throw new BadRequestError('Mỗi dòng món ăn phải chứa số lượng và giá.');
      }

      let finalProductId = productId;

      if (productName && productName.trim()) {
        const trimmedName = productName.trim();
        const normName = trimmedName.toLowerCase().trim();

        let matchedProduct = allUserProducts.find(
          (p) => p.name.toLowerCase().trim() === normName
        );

        if (!matchedProduct) {
          // So khớp bán phần
          matchedProduct = allUserProducts.find((p) => {
            const normP = p.name.toLowerCase().trim();
            return normName.includes(normP) || normP.includes(normName);
          });
        }

        if (matchedProduct) {
          finalProductId = matchedProduct.id;
        } else {
          finalProductId = monLeProduct.id;
        }
      }

      let product = productMap.get(finalProductId);
      if (!product) {
        product = allUserProducts.find((p) => p.id === finalProductId);
      }

      if (!product) {
        throw new NotFoundError('Món ăn/sản phẩm không tồn tại trong thực đơn.');
      }

      const quantity = parseFloat(reqQuantity);
      const price = parseFloat(reqPrice);
      if (quantity <= 0 || price < 0) {
        throw new BadRequestError('Số lượng và đơn giá phải lớn hơn hoặc bằng 0.');
      }

      const amount = Math.round(quantity * price);
      calculatedTotal += amount;

      formattedItems.push({
        productId: product.id,
        quantity,
        price,
        amount,
      });
    }

    const transaction = await prisma.$transaction(async (txPrisma) => {
      return await txPrisma.transaction.create({
        data: {
          customerId,
          userId,
          date: date ? new Date(date) : new Date(),
          note: note?.trim() || null,
          totalAmount: calculatedTotal,
          type: 'store',
          items: {
            create: formattedItems.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              price: item.price,
              amount: item.amount,
            })),
          },
        },
        include: {
          items: true,
        },
      });
    });

    await logActivity(
      userId,
      'CREATE_STORE_TRANSACTION',
      `Ghi hóa đơn gọi món cho ${table.name} tổng số tiền: ${calculatedTotal}đ`
    );

    res.status(201).json({
      success: true,
      data: transaction,
    });
  } catch (error) {
    next(error);
  }
};

// 15. Hủy/Xóa hóa đơn gọi món
const deleteTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const transaction = await prisma.transaction.findFirst({
      where: {
        id,
        userId,
        type: 'store',
      },
    });

    if (!transaction) {
      throw new NotFoundError('Hóa đơn gọi món không tồn tại.');
    }

    await prisma.$transaction([
      prisma.transactionItem.deleteMany({
        where: { transactionId: id },
      }),
      prisma.transaction.delete({
        where: { id },
      }),
    ]);

    await logActivity(userId, 'DELETE_STORE_TRANSACTION', `Hủy hóa đơn gọi món giá trị ${transaction.totalAmount}đ`);

    res.status(200).json({
      success: true,
      message: 'Hủy hóa đơn gọi món thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 16. Lấy danh sách các đợt thanh toán hóa đơn bàn ăn
const getPayments = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { customerId } = req.query;

    const whereClause = {
      customer: {
        userId,
      },
      type: 'store',
    };

    if (customerId) {
      whereClause.customerId = customerId;
    }

    const payments = await prisma.payment.findMany({
      where: whereClause,
      include: {
        customer: {
          select: { name: true },
        },
      },
      orderBy: {
        paidAt: 'desc',
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

// 17. Thực hiện thanh toán cho bàn ăn
const createPayment = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { customerId, amount: reqAmount, paidAt, note } = req.body;

    if (!customerId || reqAmount === undefined) {
      throw new BadRequestError('Bàn ăn và số tiền thanh toán là bắt buộc.');
    }

    const amount = parseFloat(reqAmount);
    if (isNaN(amount) || amount <= 0) {
      throw new BadRequestError('Số tiền thanh toán phải lớn hơn 0.');
    }

    const table = await prisma.customer.findFirst({
      where: { id: customerId, userId, isActive: true, type: 'store' },
    });

    if (!table) {
      throw new NotFoundError('Bàn ăn không tồn tại.');
    }

    const payment = await prisma.payment.create({
      data: {
        customerId,
        amount,
        paidAt: paidAt ? new Date(paidAt) : new Date(),
        note: note?.trim() || 'Thanh toán bàn',
        type: 'store',
      },
    });

    await logActivity(userId, 'CREATE_STORE_PAYMENT', `Thanh toán hóa đơn cho ${table.name} số tiền: ${amount}đ`);

    res.status(201).json({
      success: true,
      data: payment,
    });
  } catch (error) {
    next(error);
  }
};

// 18. Nhận diện hình ảnh tích kê/hóa đơn qua Google Gemini API
const scanInvoice = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { image } = req.body;

    if (!image) {
      throw new BadRequestError('Hình ảnh hóa đơn là bắt buộc dưới dạng base64.');
    }

    let mimeType = 'image/jpeg';
    let base64Data = image;

    if (image.startsWith('data:')) {
      const parts = image.split(';base64,');
      mimeType = parts[0].split(':')[1];
      base64Data = parts[1];
    }

    const apiKey = process.env.GEMINI_API_KEY;
    const modelName = 'gemini-3.1-pro-preview';

    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
      const mockItems = [
        { name: 'Bún chả', quantity: 2, price: 45000, amount: 90000 },
        { name: 'Nước ngọt', quantity: 2, price: 15000, amount: 30000 },
      ];
      const matchedMockItems = await matchOrCreateStoreProducts(userId, mockItems);
      return res.status(200).json({
        success: true,
        isMock: true,
        data: matchedMockItems,
      });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `Bạn là trợ lý OCR chuyên nghiệp, chuyên trích xuất dữ liệu từ hình ảnh hóa đơn nhà hàng, tích kê thanh toán quán ăn, quán nước viết tay tiếng Việt.

Hãy đọc tên khách hàng hoặc tên bàn ăn ở phía trên hóa đơn (thường ghi "Bàn 1", "Bàn 2" hoặc tên người). Trả về đúng tên viết tay đọc được vào trường customer_name. Nếu không đọc rõ, trả về customer_name = null.

Hãy tập trung phân tích BẢNG CHI TIẾT MÓN ĂN/UỐNG trong hình ảnh. Bảng gồm các cột:
- STT (Số thứ tự): có thể có hoặc trống.
- Tên món ăn/đồ uống: Tên viết tay (Ví dụ: "Bún chả", "Bia", "Nước ngọt").
- Số lượng: Số lượng (thường tính bằng phần, đĩa, chai, lon). Nếu trống nhưng có thành tiền, hãy mặc định số lượng là 1.
- Đơn giá: Giá tiền mỗi đơn vị. NẾU KHÔNG GHI ĐƠN GIÁ, hãy tính Đơn giá = Thành tiền / Số lượng (làm tròn thành số nguyên).
- Thành tiền: Tổng số tiền cuối cùng của dòng đó. Chữ số viết tay thường ghi tắt hàng nghìn (Ví dụ: "150" nghĩa là 150000, "45" nghĩa là 45000). Hãy nhân giá trị này với 1,000 để ra số tiền thực tế đầy đủ đơn vị VNĐ.
- Tổng cộng (ở cuối bảng): Tổng số tiền cuối cùng của toàn bộ hóa đơn. Thường viết tắt hàng nghìn.

Lưu ý quy đổi:
- Nếu tích kê không ghi đơn giá và thành tiền, hãy cứ liệt kê đầy đủ tên món ăn và số lượng, còn lại để trống (price = null, amount = null) để người dùng tự nhập tay.
- Nếu cột đơn giá trống nhưng có số lượng và thành tiền, bắt buộc phải tính: price = amount / quantity (làm tròn thành số nguyên).
- Nếu cột số lượng trống nhưng có thành tiền, hãy để quantity = 1 và price = amount.
- Chỉ trả về chuỗi JSON hợp lệ theo đúng cấu trúc schema yêu cầu.`,
              },
              {
                inlineData: {
                  mimeType,
                  data: base64Data,
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0,
          maxOutputTokens: 8192,
          responseSchema: {
            type: 'OBJECT',
            properties: {
              items: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    name: { type: 'STRING' },
                    quantity: { type: 'NUMBER' },
                    price: { type: 'NUMBER' },
                    amount: { type: 'NUMBER' },
                  },
                  required: ['name', 'quantity'],
                },
              },
              customer_name: { type: 'STRING', nullable: true },
            },
            required: ['items', 'customer_name'],
          },
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Lỗi Gemini API: ${response.status} - ${errText}`);
    }

    const result = await response.json();
    const textResponse = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!textResponse) {
      throw new Error('Gemini không phản hồi dữ liệu.');
    }

    const parsedJson = JSON.parse(textResponse);
    const matchedItems = await matchOrCreateStoreProducts(userId, parsedJson.items);

    res.status(200).json({
      success: true,
      customerName: parsedJson.customer_name || null,
      data: matchedItems,
    });
  } catch (error) {
    next(error);
  }
};

// 19. Nhận diện giọng nói gọi món qua Google Gemini API
const voiceToText = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { audio, mimeType: reqMimeType, transcript } = req.body;

    if (!audio && !transcript) {
      throw new BadRequestError('Dữ liệu ghi âm hoặc văn bản transcript là bắt buộc.');
    }

    const apiKey = process.env.GEMINI_API_KEY;
    const currentDate = new Date();
    const formattedCurrentDate = `${currentDate.getFullYear()}-${(currentDate.getMonth() + 1).toString().padStart(2, '0')}-${currentDate.getDate().toString().padStart(2, '0')}`;

    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
      const mockText = transcript || 'Bàn 3 gọi 2 đĩa bún chả, 2 cốc trà đá';
      const mockItems = [
        { name: 'Bún chả', quantity: 2, price: 45000, amount: 90000 },
        { name: 'Trà đá', quantity: 2, price: 5000, amount: 10000 },
      ];
      const matchedMockItems = await matchOrCreateStoreProducts(userId, mockItems);
      return res.status(200).json({
        success: true,
        isMock: true,
        customerName: 'Bàn 3',
        date: formattedCurrentDate,
        rawTranscript: mockText,
        data: matchedMockItems,
      });
    }

    const systemPrompt = `Bạn là hệ thống trích xuất dữ liệu AI chuyên nghiệp cho ứng dụng quản lý quán ăn, nhà hàng, quán nước. Nhiệm vụ của bạn là phân tích câu thoại giọng nói (hoặc văn bản) và trả về JSON có cấu trúc.

## PHÂN LOẠI GIAO DỊCH (transaction_type):
1. "ghi_no": Phát sinh gọi món ăn uống cho bàn (Ví dụ: "bàn 5 gọi 2 đĩa bún chả", "bàn 1 uống 3 bia").
2. "tra_tien": Thanh toán/trả tiền bàn ăn (Ví dụ: "bàn 3 thanh toán", "bàn 2 trả tiền").
3. "unrelated": Câu thoại không liên quan.

## BẢNG CHI TIẾT MÓN ĂN/UỐNG (Dành cho transaction_type = "ghi_no"):
- Trích xuất danh sách các món ăn/đồ uống được nhắc đến.
- name: Tên món ăn (Ví dụ: "bún chả", "bia hà nội", "trà đá").
- quantity: Số lượng gọi (Ví dụ: 2 phần, 3 chai -> 2, 3). Nếu không nhắc đến số lượng, mặc định là 1.
- price: Đơn giá mỗi món (nếu người nói có nhắc đến).
- amount: Thành tiền của món đó.

Quy tắc:
- Trích xuất tên bàn ăn/khách hàng vào trường customer_name (Ví dụ: "bàn 3", "bàn 5", "chị Hoa").
- Trả về JSON theo schema yêu cầu.`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${apiKey}`;

    let parts = [];
    if (audio) {
      let cleanBase64 = audio;
      let mimeType = reqMimeType || 'audio/webm';
      if (audio.startsWith('data:')) {
        const audioParts = audio.split(';base64,');
        mimeType = audioParts[0].split(':')[1];
        cleanBase64 = audioParts[1];
      }
      parts.push({
        inlineData: {
          mimeType,
          data: cleanBase64,
        },
      });
    }

    const textPrompt = `Hôm nay là ngày: ${formattedCurrentDate}.
Hãy phân tích câu nói: "${transcript || 'Hãy nghe file ghi âm đính kèm để trích xuất'}"`;

    parts.push({ text: textPrompt });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts }],
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0,
          responseSchema: {
            type: 'OBJECT',
            properties: {
              transaction_type: { type: 'STRING' },
              customer_name: { type: 'STRING', nullable: true },
              items: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    name: { type: 'STRING' },
                    quantity: { type: 'NUMBER' },
                    price: { type: 'NUMBER', nullable: true },
                    amount: { type: 'NUMBER', nullable: true },
                  },
                  required: ['name', 'quantity'],
                },
              },
            },
            required: ['transaction_type', 'customer_name'],
          },
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Lỗi Gemini API: ${response.status} - ${errText}`);
    }

    const result = await response.json();
    const textResponse = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!textResponse) {
      throw new Error('Gemini không phản hồi dữ liệu.');
    }

    const parsedJson = JSON.parse(textResponse);
    if (parsedJson.transaction_type === 'unrelated') {
      return res.status(200).json({
        success: true,
        customerName: null,
        data: [{ transaction_type: 'unrelated', status: 'unrelated' }],
      });
    }

    const matchedItems = await matchOrCreateStoreProducts(userId, parsedJson.items || []);

    res.status(200).json({
      success: true,
      customerName: parsedJson.customer_name || null,
      date: formattedCurrentDate,
      rawTranscript: transcript || 'Ghi âm giọng nói',
      data: matchedItems,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createTablesBulk,
  getStoreTotalRevenue,
  getStoreDailyRevenue,
  getTables,
  getTableById,
  createTable,
  updateTable,
  deleteTable,
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  getTransactions,
  createTransaction,
  deleteTransaction,
  scanInvoice,
  voiceToText,
  getPayments,
  createPayment,
};
