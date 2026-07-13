// meat-management-be/src/controllers/transaction.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');

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
            // Tự động tạo sản phẩm mới do không khớp tên nào trong DB
            const newProduct = await prisma.product.create({
              data: {
                userId,
                name: trimmedName,
                defaultPrice: reqPrice, // lấy đơn giá hiện tại làm giá mặc định
                unit: 'kg',
              },
            });
            console.log(`[TRANSACTION] Tự động tạo sản phẩm mới khi lưu nợ: ${trimmedName}`);
            // Thêm vào danh mục của chủ buôn để tránh tạo lặp nếu có dòng tiếp theo cùng tên
            allUserProducts.push(newProduct);
            finalProductId = newProduct.id;
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

      const amount = quantity * price;
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

// 3. Cập nhật thông tin đơn ghi nợ (thay toàn bộ items, ngày, ghi chú)
const updateTransaction = async (req, res, next) => {
  try {
    const userId = req.user.id;
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
      const amount = quantity * price;
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

    // Nếu không khớp với sản phẩm nào trong DB, tự động tạo mới sản phẩm với giá mặc định 100,000 VND
    if (!product) {
      product = await prisma.product.create({
        data: {
          userId,
          name: scannedName,
          defaultPrice: 100000,
          unit: 'kg'
        }
      });
      console.log(`[GEMINI] Tự động tạo sản phẩm mới do không khớp: ${scannedName}`);
    }

    resultItems.push({
      product: {
        id: product.id,
        name: product.name,
        unit: product.unit,
        defaultPrice: parseFloat(product.defaultPrice)
      },
      quantity,
      price: parseFloat(product.defaultPrice)
    });
  }

  return resultItems;
};

// 4. Nhận diện hình ảnh tích kê qua Google Gemini API
const scanTicket = async (req, res, next) => {
  try {
    const userId = req.user.id;
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
        { name: 'Thịt ba chỉ', quantity: 1.5 },
        { name: 'Sườn non', quantity: 0.8 },
        { name: 'Nạc vai', quantity: 2.2 }
      ];
      const matchedMockItems = await matchOrCreateProducts(userId, mockItems);
      return res.status(200).json({
        success: true,
        isMock: true,
        data: matchedMockItems
      });
    }

    // Gọi API của Google Gemini 2.0 Flash để nhận diện hình ảnh
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `Bạn là trợ lý OCR chuyên đọc bảng viết tay tiếng Việt.

Ảnh này là một bảng tích kê ghi nợ hàng thịt, viết tay trên giấy kẻ ô.

CẤU TRÚC BẢNG:
- Cột đầu tiên bên trái: "TT" = số thứ tự ngày (1, 2, 3... đến 31)
- Các cột tiếp theo (từ trái sang phải) là TÊN CÁC LOẠI THỊT ghi ở hàng tiêu đề trên cùng
- Mỗi ô trong bảng chứa số lượng kg của loại thịt đó trong ngày đó
- Ô trống = không giao hàng ngày đó
- Dòng cuối cùng (TT = số lớn nhất) có thể là dòng tổng cộng

NHIỆM VỤ:
1. Đọc tên tất cả các cột thịt từ hàng tiêu đề
2. Với MỖI dòng TT từ 1 đến dòng cuối cùng có dữ liệu thực (không phải dòng tổng):
   - Ghi nhận số TT (ngày)
   - Đọc giá trị kg của từng cột có số
3. Bỏ qua dòng tổng cộng (thường là dòng có ký hiệu "=" hoặc "Σ")

TRẢ VỀ KẾT QUẢ duy nhất là JSON hợp lệ theo cấu trúc sau, không có markdown, không có giải thích:
{
  "columns": ["tên_cột_1", "tên_cột_2", ...],
  "rows": [
    {"tt": 1, "tên_cột_1": số_hoặc_null, "tên_cột_2": số_hoặc_null, ...},
    {"tt": 2, ...},
    ...
  ],
  "last_day": số_TT_cuối_cùng_có_dữ_liệu_thực
}

Lưu ý quan trọng:
- Chữ số viết tay có thể nhầm: "1" và "7", "3" và "8", "9" và "4" — đọc cẩn thận theo ngữ cảnh
- Dấu phẩy trong số là dấu thập phân (ví dụ: 14,88 = 14.88 kg)
- Nếu không đọc được rõ, ghi null`
              },
              {
                text: `IMPORTANT OCR OVERRIDE: Do not assume the image is a monthly matrix. It may be a handwritten or printed meat ticket with one product per row, columns such as product, quantity, unit, price, and total. Read the actual visible rows from top to bottom. Ignore headers, subtotals, totals, dates, customer names, phone numbers, and crossed-out rows. Return only the products that have a clearly readable positive quantity. Normalize Vietnamese product names without inventing missing text. If a quantity is unclear, omit that row instead of guessing. Return exactly this JSON shape: {"items":[{"name":"string","quantity":0}]} with no other keys.`,
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
          responseMimeType: "application/json",
          temperature: 0,
          responseSchema: {
            type: "OBJECT",
            properties: {
              items: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    name: { type: "STRING" },
                    quantity: { type: "NUMBER" }
                  },
                  required: ["name", "quantity"]
                }
              }
            },
            required: ["items"]
          }
        }
      })
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

    const matchedItems = await matchOrCreateProducts(userId, parsedItems);
    res.status(200).json({
      success: true,
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
    const userId = req.user.id;
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
      return res.status(200).json({
        success: true,
        isMock: true,
        customerId: null,
        customerName: "chị Lan",
        data: {
          transaction_type: mockText.includes('trả') ? "tra_tien" : "ghi_no_thu_cong",
          date: formattedCurrentDate,
          date_inferred: true,
          customer_name: "chị Lan",
          weight_kg: mockText.includes('trả') ? null : 2,
          meat_type: mockText.includes('trả') ? null : "ba chỉ",
          amount: mockText.includes('trả') ? 100000 : 150000,
          paid_full: false,
          status: "complete",
          missing_fields: [],
          raw_transcript: mockText
        }
      });
    }

    // 2. Định nghĩa System Prompt chung cho cả âm thanh và văn bản
    const systemPrompt = `Bạn là hệ thống trích xuất dữ liệu cho ứng dụng quản lý sổ nợ bán thịt. Nhiệm vụ của bạn là phân tích câu nói (đã được chuyển từ giọng nói sang văn bản hoặc trực tiếp qua âm thanh) và trả về dữ liệu có cấu trúc dưới dạng JSON.

## PHÂN LOẠI GIAO DỊCH
Có 3 loại giao dịch, xác định dựa trên các dấu hiệu sau:
1. ghi_no_nhanh (Ghi nợ nhanh): Câu nói có ngày + tên khách + số tiền, KHÔNG đề cập số kg thịt hoặc loại thịt.
   Ví dụ: "Ngày 5 tháng 7, chị Lan, nợ 200 nghìn"
2. ghi_no_thu_cong (Ghi nợ thủ công): Câu nói có đầy đủ ngày + tên khách + số kg thịt + số tiền.
   Ví dụ: "Ngày 5 tháng 7, chị Lan, 2 cân ba chỉ, 150 nghìn"
3. tra_tien (Trả tiền): Câu nói có ngày + tên khách + số tiền, và mang ý nghĩa thanh toán/trả nợ (không phải phát sinh nợ mới).
   - Nếu người nói dùng các từ "trả đủ", "đã trả đủ", "đã trả" (không kèm số tiền cụ thể, hoặc có ý nghĩa thanh toán toàn bộ) → đánh dấu paid_full = true, amount = null (hệ thống sẽ tự tính số dư nợ hiện tại).
   - Nếu có số tiền cụ thể đi kèm (ví dụ "trả 100 nghìn") → paid_full = false, amount = 100000.

## QUY TẮC NHẬN DIỆN
- Ngày (date): Nhận diện định dạng ngày tháng nói bằng lời (VD: "ngày 5 tháng 7", "hôm nay", "hôm qua", "mùng 5"). Nếu không đọc ngày, mặc định là ngày hiện tại (${formattedCurrentDate}) và ghi rõ trong trường "date_inferred": true.
- Tên khách (customer_name): Trích xuất chính xác tên/danh xưng được nói (VD: "chị Lan", "anh Tuấn", "cô Ba"). Giữ nguyên danh xưng nếu có.
- Số kg thịt (weight_kg): Chuyển đổi các cách nói như "2 cân", "2 ký", "2kg" thành số (2). Nếu không đọc → null.
- Loại thịt (meat_type): Trích xuất tên loại thịt nếu có (VD: "ba chỉ", "nạc vai", "sườn"). Nếu không đọc → null.
- Số tiền (amount): Chuyển đổi cách nói tiền tệ Việt Nam sang số nguyên (VNĐ):
  - "150 nghìn" / "150k" → 150000
  - "1 triệu 2" → 1200000
  - "hai trăm nghìn" → 200000
- Nếu câu nói không đủ thông tin bắt buộc (thiếu tên khách hoặc thiếu số tiền khi không phải trường hợp trả đủ), đặt "status": "incomplete" và liệt kê trường còn thiếu trong "missing_fields".

## ĐỊNH DẠNG OUTPUT
Chỉ trả về JSON, không thêm giải thích, không thêm markdown code fence. Cấu trúc:
{
  "transaction_type": "ghi_no_nhanh" | "ghi_no_thu_cong" | "tra_tien",
  "date": "YYYY-MM-DD",
  "date_inferred": boolean,
  "customer_name": string,
  "weight_kg": number | null,
  "meat_type": string | null,
  "amount": number | null,
  "paid_full": boolean,
  "status": "complete" | "incomplete",
  "missing_fields": string[],
  "raw_transcript": string
}`;
    // 3. Chuẩn bị nội dung gửi cho Gemini tùy thuộc vào đầu vào là âm thanh hay văn bản
    let modelName = 'gemini-2.0-flash'; // Dùng gemini-2.0-flash cho cả âm thanh và văn bản vì hỗ trợ multimodal tốt
    const contents = [
      {
        parts: []
      }
    ];

    if (audio) {
      let mimeType = reqMimeType || 'audio/webm';
      let base64Data = audio;

      if (audio.startsWith('data:')) {
        const parts = audio.split(';base64,');
        mimeType = parts[0].split(':')[1];
        base64Data = parts[1];
      }

      contents[0].parts.push({ text: systemPrompt + '\nHãy nghe file âm thanh dưới đây và trích xuất dữ liệu thành cấu trúc JSON trên. Đọc lời thoại trích xuất được điền vào trường "raw_transcript".' });
      contents[0].parts.push({
        inlineData: {
          mimeType,
          data: base64Data
        }
      });
    } else {
      // Đầu vào là văn bản
      modelName = 'gemini-2.5-flash'; // Dùng gemini-2.5-flash tối ưu hơn cho văn bản chữ
      contents[0].parts.push({ text: systemPrompt + `\nBây giờ hãy phân tích transcript sau đây và trả về JSON:\n"${transcript}"` });
    }

    // 4. Gọi API của Google Gemini
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents,
        generationConfig: {
          responseMimeType: "application/json"
        }
      })
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

    const parsedData = JSON.parse(textResponse.trim());

    // So khớp khách hàng trong DB dựa trên customer_name trích xuất từ Gemini
    let matchedCustomer = null;
    if (parsedData && parsedData.customer_name) {
      const customers = await prisma.customer.findMany({
        where: { userId, isActive: true }
      });
      const cleanSearchName = normalizeName(parsedData.customer_name);

      matchedCustomer = customers.find(c => normalizeName(c.name) === cleanSearchName);
      if (!matchedCustomer) {
        // Tìm kiếm so khớp chứa bán phần
        matchedCustomer = customers.find(c =>
          normalizeName(c.name).includes(cleanSearchName) || cleanSearchName.includes(normalizeName(c.name))
        );
      }
    }

    res.status(200).json({
      success: true,
      customerId: matchedCustomer ? matchedCustomer.id : null,
      customerName: matchedCustomer ? matchedCustomer.name : (parsedData ? parsedData.customer_name : null),
      data: parsedData
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
    const userId = req.user.id;
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

    // Thực hiện xóa giao dịch (bảng transaction_items tự động xóa theo cascade)
    await prisma.transaction.delete({
      where: { id },
    });

    await logActivity(
      userId,
      'DELETE_TRANSACTION',
      `Xóa đơn nợ của khách hàng ${customer?.name || 'ẩn'}: Số tiền ${existing.totalAmount.toLocaleString('vi-VN')}đ`
    );

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
