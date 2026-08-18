// meat-management-be/src/controllers/transaction.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');
const { recordAiUsage } = require('../utils/aiUsage');
const { callGeminiWithRetry } = require('../utils/geminiHelper');
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

// Hàm chuẩn hóa tên tiếng Việt phục vụ so khớp giọng nói
const normalizeName = (str) => {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Loại bỏ dấu tiếng Việt
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .replace(/\s+/g, ''); // Loại bỏ khoảng trắng
};

// Hàm tính độ tương đồng từ ngữ giữa 2 tên (Fuzzy Word Match)
const calculateNameSimilarity = (name1, name2) => {
  const getWords = (str) => {
    if (!str) return [];
    return str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'd')
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  };

  const words1 = getWords(name1);
  const words2 = getWords(name2);
  if (words1.length === 0 || words2.length === 0) return 0;

  let matches = 0;
  const tempWords2 = [...words2];
  for (const w1 of words1) {
    const idx = tempWords2.indexOf(w1);
    if (idx !== -1) {
      matches++;
      tempWords2.splice(idx, 1);
    }
  }

  return (2 * matches) / (words1.length + words2.length);
};

// 1. Tạo đơn hàng ghi nợ mới (Transaction)
const createTransaction = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
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
    const productIds = items.filter((i) => i.productId).map((i) => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, userId, isActive: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    // Lấy danh mục sản phẩm đầy đủ của chủ buôn này để so khớp khi sửa tên
    const allUserProducts = await prisma.product.findMany({
      where: { userId, isActive: true },
    });

    // Kiểm tra tính hợp lệ và tính tổng tiền của từng dòng mặt hàng
    let calculatedTotal = 0;
    const formattedItems = [];

    for (const item of items) {
      const { productId, productName, quantity: reqQuantity, price: reqPrice } = item;

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

        if (currentProdNameNorm !== normScanned) {
          // Người dùng đã sửa tên sản phẩm! Tìm sản phẩm tương ứng trong danh sách của chủ buôn
          let matchedProduct = allUserProducts.find(
            (p) => p.name.toLowerCase().replace(/\s+/g, '') === normScanned
          );

          if (!matchedProduct) {
            // Tìm kiểu so khớp bán phần
            matchedProduct = allUserProducts.find((p) => {
              const normPName = p.name.toLowerCase().replace(/\s+/g, '');
              return normScanned.includes(normPName) || normPName.includes(normScanned);
            });
          }

          if (matchedProduct) {
            finalProductId = matchedProduct.id;
          } else {
            // Không tự động tạo sản phẩm mới để tránh ô nhiễm danh mục sản phẩm của chủ buôn.
            // Thay vào đó, tìm kiếm sản phẩm generic "Thịt lẻ" để gán, hoặc tạo nó duy nhất 1 lần nếu chưa có.
            let genericProduct = allUserProducts.find(
              (p) => p.name.toLowerCase().trim() === 'thịt lẻ'
            );
            if (!genericProduct) {
              genericProduct = await prisma.product.create({
                data: {
                  userId,
                  createdBy: req.user.id,
                  name: 'Thịt lẻ',
                  defaultPrice: reqPrice,
                  unit: 'kg',
                },
              });
              allUserProducts.push(genericProduct);
            }
            finalProductId = genericProduct.id;
          }
        }
      }

      if (!finalProductId) {
        throw new BadRequestError('Không thể xác định hoặc tạo mới sản phẩm cho dòng mặt hàng này.');
      }

      // Xác thực lại sản phẩm
      let product = productMap.get(finalProductId);
      if (!product) {
        // Tìm trong danh mục đầy đủ (đã bao gồm các sản phẩm mới được tạo trong vòng lặp này)
        product = allUserProducts.find((p) => p.id === finalProductId);
      }

      if (!product) {
        throw new NotFoundError(`Sản phẩm thịt không tồn tại hoặc đã bị ẩn.`);
      }

      const quantity = parseFloat(reqQuantity);
      const price = parseFloat(reqPrice);
      if (quantity <= 0 || price < 0) {
        throw new BadRequestError('Số lượng thịt phải lớn hơn 0 và đơn giá không được âm.');
      }

      const amount = Math.round(quantity * price);
      calculatedTotal += amount;

      formattedItems.push({
        productId: finalProductId,
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
          createdBy: req.user.id,
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

      // Cập nhật hoặc lưu mới đơn giá thịt của loại thịt này cho khách hàng này
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
          },
          create: {
            customerId,
            productId: item.productId,
            price: item.price,
          },
        });
      }

      return transaction;
    });

    await logActivity(
      userId,
      'CREATE_TRANSACTION',
      `Ghi nợ đơn hàng mới cho khách ${customer.name}: Tổng tiền ${calculatedTotal.toLocaleString('vi-VN')}đ`
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
    const { customerId, createdBy, todayOnly, date } = req.query;

    const whereClause = { userId };
    if (customerId) {
      whereClause.customerId = customerId;
    }

    // Lọc theo người tạo đơn (dùng cho nhân viên xem đơn của mình)
    if (createdBy) {
      whereClause.createdBy = createdBy;
    }

    // Lọc theo ngày cụ thể (YYYY-MM-DD) hoặc ngày hôm nay (theo múi giờ UTC+7)
    if (date) {
      const dateParts = date.split('-');
      if (dateParts.length === 3) {
        const year = parseInt(dateParts[0], 10);
        const month = parseInt(dateParts[1], 10) - 1; // Tháng tính từ 0
        const dayVal = parseInt(dateParts[2], 10);

        // Đầu ngày và cuối ngày theo giờ Việt Nam, quy đổi sang UTC
        const startUTC = new Date(Date.UTC(year, month, dayVal, 0, 0, 0, 0) - 7 * 60 * 60 * 1000);
        const endUTC = new Date(Date.UTC(year, month, dayVal, 23, 59, 59, 999) - 7 * 60 * 60 * 1000);
        whereClause.createdAt = { gte: startUTC, lte: endUTC };
      }
    } else if (todayOnly === 'true') {
      const now = new Date();
      // Tính thời gian hiện tại theo múi giờ Việt Nam (UTC+7)
      const nowVN = new Date(now.getTime() + 7 * 60 * 60 * 1000);
      const year = nowVN.getUTCFullYear();
      const month = nowVN.getUTCMonth();
      const dateVal = nowVN.getUTCDate();

      // Đầu ngày và cuối ngày theo giờ Việt Nam, quy đổi sang UTC
      const startUTC = new Date(Date.UTC(year, month, dateVal, 0, 0, 0, 0) - 7 * 60 * 60 * 1000);
      const endUTC = new Date(Date.UTC(year, month, dateVal, 23, 59, 59, 999) - 7 * 60 * 60 * 1000);
      whereClause.createdAt = { gte: startUTC, lte: endUTC };
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

// 3. Cập nhật thông tin đơn ghi nợ (thay toàn bộ items, ngày, ghi chú)
const updateTransaction = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;
    const { date, note, items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestError('Danh sách mặt hàng thịt là bắt buộc.');
    }

    // Kiểm tra giao dịch có tồn tại và thuộc chủ buôn này không
    const existing = await prisma.transaction.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      throw new NotFoundError('Giao dịch không tồn tại hoặc không thuộc quyền quản lý của bạn.');
    }

    // Xác thực và tính lại tổng tiền
    const productIds = items.map((i) => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, userId, isActive: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    let calculatedTotal = 0;
    const formattedItems = [];

    for (const item of items) {
      if (!item.productId || item.quantity === undefined || item.price === undefined) {
        throw new BadRequestError('Mỗi dòng mặt hàng phải có sản phẩm, số lượng và giá bán.');
      }
      const product = productMap.get(item.productId);
      if (!product) {
        throw new NotFoundError(`Sản phẩm ID ${item.productId} không tồn tại hoặc đã bị ẩn.`);
      }
      const quantity = parseFloat(item.quantity);
      const price = parseFloat(item.price);
      if (quantity <= 0 || price < 0) {
        throw new BadRequestError('Số lượng phải > 0 và đơn giá không được âm.');
      }
      const amount = Math.round(quantity * price);
      calculatedTotal += amount;
      formattedItems.push({ productId: item.productId, quantity, price, amount });
    }

    // Cập nhật trong Prisma Transaction: xoá items cũ, tạo items mới
    const updated = await prisma.$transaction(async (tx) => {
      // Xóa toàn bộ items cũ của đơn hàng này
      await tx.transactionItem.deleteMany({ where: { transactionId: id } });

      // Cập nhật transaction và tạo items mới
      const transaction = await tx.transaction.update({
        where: { id },
        data: {
          date: date ? new Date(date) : existing.date,
          note: note !== undefined ? (note || null) : existing.note,
          totalAmount: calculatedTotal,
          items: { create: formattedItems },
        },
        include: {
          items: {
            include: {
              product: { select: { name: true, unit: true } },
            },
          },
        },
      });

      // Cập nhật hoặc lưu mới đơn giá bán thực tế của loại thịt cho khách hàng này
      const customerId = existing.customerId;
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
          },
          create: {
            customerId,
            productId: item.productId,
            price: item.price,
          },
        });
      }

      return transaction;
    });

    const customer = await prisma.customer.findUnique({
      where: { id: existing.customerId }
    });

    await logActivity(
      userId,
      'UPDATE_TRANSACTION',
      `Cập nhật đơn nợ của khách hàng ${customer?.name || 'ẩn'}: Tổng tiền mới ${calculatedTotal.toLocaleString('vi-VN')}đ`
    );
    notifyCustomerUpdate(userId, 'UPDATE_TRANSACTION', { customerId: existing.customerId, transactionId: id });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

// Hàm so khớp thông minh hoặc tạo sản phẩm mới nếu chưa có
const matchOrCreateProducts = async (userId, parsedItems) => {
  const products = await prisma.product.findMany({
    where: { userId, isActive: true }
  });

  const resultItems = [];

  for (const item of parsedItems) {
    const scannedName = item.name.trim();
    const quantity = parseFloat(item.quantity) || 0;
    if (quantity <= 0) continue;

    // Chuẩn hóa tên để so khớp (viết thường và xóa khoảng trắng)
    const normScanned = scannedName.toLowerCase().replace(/\s+/g, '');
    let matchedProduct = products.find(p => p.name.toLowerCase().replace(/\s+/g, '') === normScanned);

    if (!matchedProduct) {
      // Tìm kiểu so khớp bán phần
      matchedProduct = products.find(p => {
        const normPName = p.name.toLowerCase().replace(/\s+/g, '');
        return normScanned.includes(normPName) || normPName.includes(normScanned);
      });
    }

    let product = matchedProduct;

    // Nếu không khớp với sản phẩm nào trong DB, dùng đối tượng ảo thay vì tự ý tạo sản phẩm mới trong DB
    if (!product) {
      product = {
        id: null,
        name: scannedName,
        defaultPrice: null,
        unit: 'kg'
      };
    }

    // Chỉ lấy đơn giá/thành tiền nếu ảnh thực sự cung cấp. Không tự gán giá mặc định
    // vì người dùng cần nhập giá thủ công khi phiếu chỉ có tên hàng và số lượng.
    let price = null;
    if (item.price && parseFloat(item.price) > 0) {
      price = parseFloat(item.price);
    } else if (item.amount && parseFloat(item.amount) > 0 && quantity > 0) {
      price = Math.round(parseFloat(item.amount) / quantity);
    }

    resultItems.push({
      product: {
        id: product.id,
        name: product.name,
        unit: product.unit,
        defaultPrice: product.defaultPrice == null ? null : parseFloat(product.defaultPrice)
      },
      selectedProductId: product.id, // Sẽ là null nếu không khớp sản phẩm nào
      quantity,
      price
    });
  }

  return resultItems;
};

// 4. Nhận diện hình ảnh tích kê qua Google Gemini API
const scanTicket = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { image } = req.body;

    if (!image) {
      throw new BadRequestError('Hình ảnh tích kê là bắt buộc dưới dạng base64.');
    }

    // Tách thông tin MIME type và dữ liệu base64 nguyên bản
    let mimeType = 'image/jpeg';
    let base64Data = image;

    if (image.startsWith('data:')) {
      const parts = image.split(';base64,');
      mimeType = parts[0].split(':')[1];
      base64Data = parts[1];
    }

    const apiKey = process.env.GEMINI_API_KEY;

    // Nếu không có API Key, chạy chế độ giả lập để người dùng thử nghiệm
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
      console.log('[GEMINI] Chạy chế độ giả lập vì chưa cấu hình GEMINI_API_KEY.');
      const mockItems = [
        { name: 'Thịt ba chỉ', quantity: 1.5, price: 150000 },
        { name: 'Sườn non', quantity: 0.8, price: 180000 },
        { name: 'Nạc vai', quantity: 2.2, price: 160000 }
      ];
      const matchedMockItems = await matchOrCreateProducts(userId, mockItems);
      return res.status(200).json({
        success: true,
        isMock: true,
        usageCost: {
          model: 'gemini-2.5-flash',
          inputType: 'image',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          currency: 'USD',
        },
        data: matchedMockItems
      });
    }

    // Gọi API của Google Gemini để nhận diện hình ảnh tích kê hàng thịt với retry tự động
    const geminiResult = await callGeminiWithRetry({
      apiKey,
      contents: [
        {
          parts: [
            {
              text: `Bạn là trợ lý OCR chuyên nghiệp, chuyên trích xuất dữ liệu từ hình ảnh hóa đơn bán hàng, tích kê bán thịt viết tay tiếng Việt.

Hãy đọc thêm trường "Tên khách hàng" ở phía trên bảng (thường nằm sau nhãn "Tên khách hàng:"). Trả về đúng tên viết tay đọc được vào trường customer_name. Nếu không đọc rõ hoặc trường này để trống, trả về customer_name = null. Không lấy tên cửa hàng, tên chủ cửa hàng hoặc tên người bán làm tên khách hàng.

Hãy tập trung phân tích BẢNG CHI TIẾT HÀNG HÓA trong hình ảnh. Bảng gồm các cột:
- STT (Số thứ tự): có thể có hoặc trống.
- Tên hàng hóa: Tên loại thịt/sản phẩm viết tay (Ví dụ: "Tai", "X", "Tiết").
- Số lượng: Số lượng (thường tính bằng kg hoặc cái). Có thể sử dụng dấu phẩy làm dấu thập phân (Ví dụ: "2,04" -> 2.04). Nếu trống nhưng có thành tiền, hãy mặc định số lượng là 1.
- Đơn giá: Giá tiền mỗi đơn vị. NẾU KHÔNG GHI ĐƠN GIÁ, hãy tính Đơn giá = Thành tiền / Số lượng (làm tròn thành số nguyên).
- Thành tiền: Tổng số tiền cuối cùng của dòng đó. Chữ số viết tay thường ghi tắt hàng nghìn (Ví dụ: "490" nghĩa là 490000, "202" nghĩa là 202000, "43" nghĩa là 43000). Hãy nhân giá trị này với 1,000 để ra số tiền thực tế đầy đủ đơn vị VNĐ.
- Tổng cộng (ở cuối bảng): Tổng số tiền cuối cùng của toàn bộ hóa đơn. Thường viết tắt hàng nghìn (Ví dụ: "735" nghĩa là 735000 VNĐ). Hãy kiểm tra xem tổng các dòng thành tiền có khớp với Tổng cộng hay không để tự điều chỉnh số liệu cho chính xác (Ví dụ: 490000 + 202000 + 43000 = 735000).

Lưu ý quy đổi:
- Nếu tích kê không ghi đơn giá và thành tiền, hãy cứ liệt kê đầy đủ tên hàng hóa và số lượng, còn lại để trống (price = null, amount = null) để người dùng tự nhập tay.
- Nếu cột đơn giá trống nhưng có số lượng và thành tiền, bắt buộc phải tính: price = amount / quantity (làm tròn thành số nguyên).
- Nếu cột số lượng trống nhưng có thành tiền, hãy để quantity = 1 và price = amount.
- Chỉ trả về chuỗi JSON hợp lệ theo đúng cấu trúc schema yêu cầu.`
            },
            {
              inlineData: {
                mimeType,
                data: base64Data
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 8192,
        responseSchema: {
          type: "OBJECT",
          properties: {
            items: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  name: { type: "STRING" },
                  quantity: { type: "NUMBER" },
                  price: { type: "NUMBER" },
                  amount: { type: "NUMBER" }
                },
                required: ["name", "quantity"]
              }
            },
            customer_name: { type: "STRING", nullable: true }
          },
          required: ["items", "customer_name"]
        }
      }
    });

    const textResponse = geminiResult.text;
    const modelName = geminiResult.model;
    const resultUsage = geminiResult.usageMetadata;

    // Giải mã kết quả JSON trả về từ AI và so khớp sản phẩm
    const parsedData = JSON.parse(textResponse.trim());
    let parsedItems = [];

    if (Array.isArray(parsedData)) {
      // Hỗ trợ định dạng cũ (mảng các sản phẩm)
      parsedItems = parsedData;
    } else if (parsedData && Array.isArray(parsedData.items)) {
      parsedItems = parsedData.items;
    } else if (parsedData && Array.isArray(parsedData.rows)) {
      // Định dạng cấu trúc bảng mới
      const lastDay = parsedData.last_day;
      let lastRow = null;

      if (lastDay !== undefined && lastDay !== null) {
        lastRow = parsedData.rows.find((r) => r.tt == lastDay);
      }

      // Nếu không tìm thấy bằng last_day, lấy dòng cuối cùng trong mảng rows có dữ liệu thực
      if (!lastRow && parsedData.rows.length > 0) {
        lastRow = parsedData.rows[parsedData.rows.length - 1];
      }

      if (lastRow) {
        for (const [key, value] of Object.entries(lastRow)) {
          if (key !== 'tt' && value !== null && value !== undefined && value !== '') {
            parsedItems.push({
              name: key,
              quantity: parseFloat(value) || 0,
            });
          }
        }
      }
    }

    const scannedCustomerName = parsedData && !Array.isArray(parsedData)
      ? (parsedData.customer_name || parsedData.customerName || null)
      : null;

    const usageCost = await recordAiUsage({
      userId,
      feature: 'SCAN_TICKET',
      model: modelName,
      inputType: 'image',
      usageMetadata: resultUsage,
    });
    const matchedItems = await matchOrCreateProducts(userId, parsedItems);
    res.status(200).json({
      success: true,
      usageCost,
      customerName: scannedCustomerName,
      data: matchedItems
    });
  } catch (error) {
    console.error('[GEMINI ERROR]', error);
    let errMsg = error.message;
    if (error.message.includes('Lỗi Gemini API:')) {
      const statusMatch = error.message.match(/Lỗi Gemini API: (\d+)/);
      if (statusMatch) {
        const statusCode = parseInt(statusMatch[1], 10);
        if (statusCode === 503) {
          errMsg = 'Hệ thống nhận diện của Google đang quá tải tạm thời (Lỗi 503). Vui lòng thử lại sau vài giây.';
        } else if (statusCode === 429) {
          errMsg = 'Số lượt sử dụng của bạn đã vượt quá giới hạn cho phép trong ngày (Lỗi 429). Vui lòng thử lại sau.';
        } else {
          try {
            const jsonPart = error.message.substring(error.message.indexOf('{'));
            const errObj = JSON.parse(jsonPart);
            if (errObj && errObj.error && errObj.error.message) {
              errMsg = `Lỗi từ Google (${statusCode}): ${errObj.error.message}`;
            }
          } catch (e) {
            // Không parse được thì giữ nguyên errMsg ban đầu
          }
        }
      }
    }
    res.status(500).json({
      success: false,
      message: 'Không thể nhận diện hình ảnh tích kê: ' + errMsg
    });
  }
};

// 5. Nhận diện ghi nợ bằng giọng nói hoặc văn bản qua Google Gemini API
const voiceToText = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { audio, mimeType: reqMimeType, transcript } = req.body;

    if (!audio && !transcript) {
      throw new BadRequestError('Dữ liệu ghi âm hoặc văn bản transcript là bắt buộc.');
    }

    const apiKey = process.env.GEMINI_API_KEY;

    // Định dạng ngày hiện tại của hệ thống để chuyển vào prompt của AI
    const currentDate = new Date();
    const formattedCurrentDate = `${currentDate.getFullYear()}-${(currentDate.getMonth() + 1).toString().padStart(2, '0')}-${currentDate.getDate().toString().padStart(2, '0')}`;

    // 1. Nếu không có API Key, chạy chế độ giả lập để thử nghiệm
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
      console.log('[GEMINI] Chạy chế độ giả lập voiceToText vì chưa cấu hình GEMINI_API_KEY.');
      const mockText = transcript || "Ngày 5 tháng 7, chị Lan, 2 cân ba chỉ, 150 nghìn";
      const mockIsUnrelated = transcript && !/(ghi|nợ|no|trả|tra|tiền|tien|cân|can|kg|thịt|thit|khách|khach|ngày|ngay)/i.test(transcript);
      
      if (mockIsUnrelated) {
        return res.status(200).json({
          success: true,
          isMock: true,
          usageCost: { model: 'gemini-3.1-pro-preview', inputType: audio ? 'audio' : 'text', inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, currency: 'USD' },
          customerId: null,
          customerName: null,
          data: [{ transaction_type: "unrelated", status: "unrelated", missing_fields: [], raw_transcript: mockText }]
        });
      }

      if (mockText.includes('trả')) {
        return res.status(200).json({
          success: true,
          isMock: true,
          usageCost: { model: 'gemini-3.1-pro-preview', inputType: audio ? 'audio' : 'text', inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, currency: 'USD' },
          customerId: null,
          customerName: "chị Lan",
          data: [{ transaction_type: "tra_tien", date: formattedCurrentDate, customer_name: "chị Lan", amount: 100000, paid_full: false, status: "complete", missing_fields: [], raw_transcript: mockText }]
        });
      }

      const mockItems = [
        { name: 'ba chỉ', quantity: 2, price: 75000, amount: 150000 }
      ];
      const matchedMockItems = await matchOrCreateProducts(userId, mockItems);
      return res.status(200).json({
        success: true,
        isMock: true,
        usageCost: { model: 'gemini-3.1-pro-preview', inputType: audio ? 'audio' : 'text', inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, currency: 'USD' },
        customerId: null,
        customerName: "chị Lan",
        date: formattedCurrentDate,
        transactionType: "ghi_no",
        rawTranscript: mockText,
        data: matchedMockItems
      });
    }

    // 2. Định nghĩa System Prompt trích xuất dữ liệu giọng nói (tương tự như script chụp tích kê)
    const systemPrompt = `Bạn là hệ thống trích xuất dữ liệu AI chuyên nghiệp cho ứng dụng sổ nợ hàng thịt. Nhiệm vụ của bạn là phân tích câu thoại giọng nói (hoặc văn bản) và trả về JSON có cấu trúc.

## PHÂN LOẠI GIAO DỊCH (transaction_type):
1. "ghi_no": Phát sinh đơn nợ mới (bao gồm cả Ghi nợ thủ công theo từng loại thịt và Ghi nợ nhanh).
2. "tra_tien": Thanh toán/trả nợ (ví dụ: "chị Lan trả 100 nghìn", "anh Tuấn đã trả đủ").
   - Nếu trả số tiền cụ thể: paid_full = false, amount = số tiền.
   - Nếu trả đủ không kèm số tiền: paid_full = true, amount = null.
3. "unrelated": Câu thoại không liên quan đến ghi nợ hay trả nợ.

## BẢNG CHI TIẾT MẶT HÀNG (Dành cho transaction_type = "ghi_no"):
Trích xuất toàn bộ các mặt hàng trong câu nói vào mảng "items".
- Với mỗi mặt hàng thịt (Ghi nợ thủ công):
  - name: Tên loại thịt/sản phẩm (VD: "ba chỉ", "sườn", "nạc vai", "bắp bò").
  - quantity: Số kg hoặc số lượng (VD: 2, 1.5, 0.8). Mặc định là 1 nếu không đọc rõ số kg.
  - price: Đơn giá mỗi đơn vị (VNĐ).
  - amount: Thành tiền của dòng đó (VNĐ).
- Với trường hợp GHI NỢ NHANH (chỉ nói tên khách và số tiền nợ, KHÔNG đọc tên loại thịt hay khối lượng):
  - Đặt name = "Tiền hàng".
  - quantity = 1.
  - price = số tiền nợ.
  - amount = số tiền nợ.
  - is_quick_debt = true.

## QUY TẮC NHẬN DIỆN NGÀY VÀ TIỀN TỆ:
- Ngày (date): Tính toán ngày theo định dạng YYYY-MM-DD dựa trên ngày hiện tại của hệ thống là ${formattedCurrentDate}. Ví dụ "hôm nay" -> ${formattedCurrentDate}, "hôm qua" -> ngày hôm trước. Nếu không nhắc đến ngày, mặc định ngày hiện tại và ghi "date_inferred": true.
- Chuyển đổi cách nói tiền tệ Việt Nam sang số VNĐ:
  - "150 nghìn" / "150k" -> 150000
  - "1 triệu 2" / "1tr2" -> 1200000
  - "2 trăm" / "200k" -> 200000
- Nếu câu nói có "giá X" sau số kg (VD: "2.6 cân bắp bò giá 30"), hiểu X là nghìn đồng / 1 lạng (100g). Đơn giá/kg = X * 10 * 1000. Thành tiền amount = kg * price.

## ĐỊNH DẠNG JSON OUTPUT:
Chỉ trả về chuỗi JSON duy nhất, không thêm bất kỳ văn bản hướng dẫn nào:
{
  "transaction_type": "ghi_no" | "tra_tien" | "unrelated",
  "date": "YYYY-MM-DD",
  "date_inferred": boolean,
  "customer_name": string | null,
  "amount": number | null,
  "paid_full": boolean,
  "status": "complete" | "incomplete" | "unrelated",
  "missing_fields": string[],
  "items": [
    {
      "name": string,
      "quantity": number,
      "price": number,
      "amount": number,
      "is_quick_debt": boolean
    }
  ],
  "raw_transcript": string
}`;

    // 3. Chuẩn bị nội dung gửi cho Gemini
    const classificationPrompt = `${systemPrompt}
QUY TẮC BẮT BUỘC: Nếu câu thoại không liên quan đến ghi nợ hay trả tiền, đặt transaction_type = "unrelated", status = "unrelated", customer_name = null, items = [], missing_fields = [].
`;

    const contents = [{ parts: [] }];

    if (audio) {
      let mimeType = reqMimeType || 'audio/webm';
      let base64Data = audio;

      if (audio.startsWith('data:')) {
        const parts = audio.split(';base64,');
        mimeType = parts[0].split(':')[1];
        base64Data = parts[1];
      }

      contents[0].parts.push({ text: classificationPrompt + '\nHãy nghe file âm thanh dưới đây và trích xuất dữ liệu thành cấu trúc JSON trên. Đọc lời thoại trích xuất được điền vào trường "raw_transcript".' });
      contents[0].parts.push({
        inlineData: {
          mimeType,
          data: base64Data
        }
      });
    } else {
      contents[0].parts.push({ text: classificationPrompt + `\nBây giờ hãy phân tích transcript sau đây và trả về JSON:\n"${transcript}"` });
    }

    // 4. Gọi API của Google Gemini với retry tự động
    const geminiVoiceResult = await callGeminiWithRetry({
      apiKey,
      contents,
      generationConfig: {},
    });

    const textResponse = geminiVoiceResult.text;
    const modelName = geminiVoiceResult.model;
    const resultUsage = geminiVoiceResult.usageMetadata;

    const parsedData = JSON.parse(textResponse.trim());
    const firstResult = Array.isArray(parsedData) ? parsedData[0] : parsedData;

    const usageCost = await recordAiUsage({
      userId,
      feature: 'VOICE_TO_TEXT',
      model: modelName,
      inputType: audio ? 'audio' : 'text',
      usageMetadata: resultUsage,
    });

    // So khớp thông tin khách hàng trong DB từ customer_name đọc được
    let matchedCustomer = null;
    const rawCustomerName = firstResult ? (firstResult.customer_name || firstResult.customerName) : null;
    if (rawCustomerName) {
      const customers = await prisma.customer.findMany({
        where: { userId, isActive: true }
      });
      const cleanSearchName = normalizeName(rawCustomerName);

      // 1. Khớp chính xác hoàn toàn
      matchedCustomer = customers.find(c => normalizeName(c.name) === cleanSearchName);
      
      // 2. Khớp bán phần (chứa trong nhau)
      if (!matchedCustomer) {
        matchedCustomer = customers.find(c =>
          normalizeName(c.name).includes(cleanSearchName) || cleanSearchName.includes(normalizeName(c.name))
        );
      }

      // 3. Khớp gần giống bằng độ tương đồng từ (Fuzzy Word Match)
      if (!matchedCustomer) {
        let bestScore = 0;
        let candidates = [];
        
        for (const c of customers) {
          const score = calculateNameSimilarity(rawCustomerName, c.name);
          if (score > bestScore) {
            bestScore = score;
            candidates = [c];
          } else if (score === bestScore && score > 0) {
            candidates.push(c);
          }
        }
        
        // Chỉ chọn khớp nếu vượt qua ngưỡng an toàn (0.6) và không bị tranh chấp giữa nhiều ứng viên cùng điểm
        if (bestScore >= 0.6 && candidates.length === 1) {
          matchedCustomer = candidates[0];
        }
      }
    }

    const finalCustomerName = matchedCustomer ? matchedCustomer.name : rawCustomerName;
    const finalCustomerId = matchedCustomer ? matchedCustomer.id : null;

    // Xử lý luồng Trả tiền
    if (firstResult && firstResult.transaction_type === 'tra_tien') {
      return res.status(200).json({
        success: true,
        usageCost,
        customerId: finalCustomerId,
        customerName: finalCustomerName,
        data: [
          {
            transaction_type: 'tra_tien',
            date: firstResult.date || formattedCurrentDate,
            customer_name: finalCustomerName,
            amount: firstResult.amount || null,
            paid_full: !!firstResult.paid_full,
            status: firstResult.status || 'complete',
            missing_fields: firstResult.missing_fields || [],
            raw_transcript: firstResult.raw_transcript || transcript || ''
          }
        ]
      });
    }

    // Xử lý luồng Nội dung không liên quan
    if (firstResult && (firstResult.transaction_type === 'unrelated' || firstResult.status === 'unrelated')) {
      return res.status(200).json({
        success: true,
        usageCost,
        customerId: null,
        customerName: null,
        data: [
          {
            transaction_type: 'unrelated',
            status: 'unrelated',
            missing_fields: [],
            raw_transcript: firstResult.raw_transcript || transcript || ''
          }
        ]
      });
    }

    // Xử lý luồng Ghi nợ (Chuẩn hóa các mặt hàng theo phong cách tích kê qua matchOrCreateProducts)
    let rawItems = [];
    if (firstResult && Array.isArray(firstResult.items) && firstResult.items.length > 0) {
      rawItems = firstResult.items;
    } else if (firstResult && (firstResult.meat_type || firstResult.weight_kg || firstResult.amount)) {
      // Hỗ trợ cấu hình item đơn lẻ nếu Gemini trả theo format cũ
      rawItems = [
        {
          name: firstResult.meat_type || 'Tiền hàng',
          quantity: parseFloat(firstResult.weight_kg) || 1,
          price: firstResult.amount && (firstResult.weight_kg > 0) ? Math.round(firstResult.amount / firstResult.weight_kg) : (firstResult.amount || 0),
          amount: firstResult.amount || 0
        }
      ];
    } else if (firstResult && firstResult.amount && firstResult.amount > 0) {
      // Trường hợp ghi nợ nhanh
      rawItems = [
        {
          name: 'Tiền hàng',
          quantity: 1,
          price: firstResult.amount,
          amount: firstResult.amount,
          is_quick_debt: true
        }
      ];
    }

    // Chạy các mặt hàng trích xuất qua hàm matchOrCreateProducts
    const matchedItems = await matchOrCreateProducts(userId, rawItems);

    // Gắn thêm voiceDate và voiceCustomerName vào từng mặt hàng
    const formattedDataItems = matchedItems.map((item) => ({
      ...item,
      voiceDate: firstResult.date || formattedCurrentDate,
      voiceCustomerName: finalCustomerName || '',
      rawTranscript: firstResult.raw_transcript || transcript || '',
    }));

    res.status(200).json({
      success: true,
      usageCost,
      customerId: finalCustomerId,
      customerName: finalCustomerName,
      date: firstResult.date || formattedCurrentDate,
      transactionType: 'ghi_no',
      rawTranscript: firstResult.raw_transcript || transcript || '',
      data: formattedDataItems
    });
  } catch (error) {
    console.error('[GEMINI PARSE ERROR]', error);
    let errMsg = error.message;
    if (error.message.includes('Lỗi Gemini API:')) {
      const statusMatch = error.message.match(/Lỗi Gemini API: (\d+)/);
      if (statusMatch) {
        const statusCode = parseInt(statusMatch[1], 10);
        if (statusCode === 503) {
          errMsg = 'Hệ thống nhận diện của Google đang quá tải tạm thời (Lỗi 503). Vui lòng thử lại sau vài giây.';
        } else if (statusCode === 429) {
          errMsg = 'Số lượt sử dụng của bạn đã vượt quá giới hạn cho phép trong ngày (Lỗi 429). Vui lòng thử lại sau.';
        } else {
          try {
            const jsonPart = error.message.substring(error.message.indexOf('{'));
            const errObj = JSON.parse(jsonPart);
            if (errObj && errObj.error && errObj.error.message) {
              errMsg = `Lỗi từ Google (${statusCode}): ${errObj.error.message}`;
            }
          } catch (e) {
            // Lỗi parse thì giữ nguyên
          }
        }
      }
    }
    res.status(500).json({
      success: false,
      message: 'Không thể phân tích transcript: ' + errMsg
    });
  }
};

// 6. Xóa giao dịch ghi nợ thịt (Transaction) theo ID
const deleteTransaction = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;

    // Kiểm tra giao dịch có tồn tại và thuộc chủ buôn này không
    const existing = await prisma.transaction.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      throw new NotFoundError('Giao dịch không tồn tại hoặc không thuộc quyền quản lý của bạn.');
    }

    const customer = await prisma.customer.findUnique({
      where: { id: existing.customerId }
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

    await logActivity(
      userId,
      'DELETE_TRANSACTION',
      `Xóa đơn nợ của khách hàng ${customer?.name || 'ẩn'}: Số tiền ${existing.totalAmount.toLocaleString('vi-VN')}đ`
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

// 7. Phân tích câu nói ghi nợ/trả tiền dạng văn bản qua Google Gemini API
const parseTranscript = async (req, res, next) => {
  return voiceToText(req, res, next);
};

module.exports = {
  createTransaction,
  getTransactions,
  updateTransaction,
  scanTicket,
  voiceToText,
  deleteTransaction,
  parseTranscript,
};
