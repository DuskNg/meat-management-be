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
      return tx.transaction.update({
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
    });

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

    // Gọi API của Google Gemini 2.5 Flash để nhận diện hình ảnh
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
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
                inlineData: {
                  mimeType,
                  data: base64Data
                }
              }
            ]
          }
        ],
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

    // Giải mã kết quả JSON trả về từ AI và so khớp sản phẩm
    const parsedData = JSON.parse(textResponse.trim());
    let parsedItems = [];

    if (Array.isArray(parsedData)) {
      // Hỗ trợ định dạng cũ (mảng các sản phẩm)
      parsedItems = parsedData;
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

// 5. Nhận diện ghi nợ bằng giọng nói tiếng Việt qua Google Gemini API
const voiceToText = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { audio, mimeType: reqMimeType } = req.body;

    if (!audio) {
      throw new BadRequestError('Dữ liệu ghi âm giọng nói là bắt buộc dưới dạng base64.');
    }

    // Tách thông tin MIME type và dữ liệu base64 nguyên bản
    let mimeType = reqMimeType || 'audio/webm';
    let base64Data = audio;

    if (audio.startsWith('data:')) {
      const parts = audio.split(';base64,');
      mimeType = parts[0].split(':')[1];
      base64Data = parts[1];
    }

    const apiKey = process.env.GEMINI_API_KEY;

    // Nếu không có API Key, chạy chế độ giả lập để thử nghiệm
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
      console.log('[GEMINI] Chạy chế độ giả lập Voice-to-Text vì chưa cấu hình GEMINI_API_KEY.');
      // Trích xuất giả lập: "ngày 26/6 1 cân bắp bò giá 29"
      const mockResult = {
        date: new Date(2026, 5, 26).toISOString(), // 26/06/2026
        items: [
          { name: 'bắp bò', quantity: 1.0, price: 290000 }
        ],
        note: 'Lời dịch giọng nói giả lập: ngày 26/6 1 cân bắp bò giá 29'
      };

      const matchedMockItems = await matchOrCreateProducts(userId, mockResult.items);
      const finalMockItems = matchedMockItems.map((matchedItem) => {
        const aiItem = mockResult.items.find(
          (ai) => ai.name.toLowerCase().trim() === matchedItem.product.name.toLowerCase().trim()
        );
        if (aiItem && aiItem.price && parseFloat(aiItem.price) > 0) {
          return {
            ...matchedItem,
            price: parseFloat(aiItem.price),
          };
        }
        return matchedItem;
      });

      return res.status(200).json({
        success: true,
        isMock: true,
        data: {
          date: mockResult.date,
          items: finalMockItems,
          note: mockResult.note
        }
      });
    }

    // Gọi API của Google Gemini 2.5 Flash để nhận diện âm thanh
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
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
                text: `Bạn là trợ lý ảo chuyên ghi chép đơn hàng thịt bằng giọng nói tại Việt Nam.
Nhiệm vụ của bạn là nghe file âm thanh ghi âm giọng nói của chủ cửa hàng (tiếng Việt), chuyển thành văn bản và trích xuất thông tin giao dịch ghi nợ thịt.

HƯỚNG DẪN HIỂU CÁC KÝ HIỆU / THUẬT NGỮ ĐỊA PHƯƠNG:
1. Về Ngày Ghi Nợ:
- Nếu người dùng nói ngày cụ thể (ví dụ: "ngày 26/6", "hôm qua", "20 tháng 5"), trích xuất ngày đó và đưa về định dạng ISO Date (năm mặc định là 2026, ví dụ: "26/6" -> "2026-06-26").
- Nếu không nói ngày, mặc định ngày là hôm nay (22/06/2026).

2. Về Số Lượng & Đơn Vị (Quy đổi tất cả sang kg):
- "1 cân", "1 ký", "1 kg" = 1.0
- "1 lạng", "1 chỉ" (đối với lòng/thịt lẻ) = 0.1
- "nửa cân", "nửa ký" = 0.5
- "2 lạng rưỡi" = 0.25

3. Về Đơn Giá (Quy đổi đơn giá về đơn vị VND/kg):
- Quy tắc ngầm định của chủ buôn thịt Việt Nam:
  - Nếu đơn giá được nói dưới 100 và không kèm từ "nghìn/kg" (ví dụ: "giá 29", "giá 32", "giá 25"), tự hiểu đó là giá tính theo "lạng" (100g) bằng nghìn đồng. Bạn phải nhân 10 để quy ra giá trên 1 kg. Ví dụ: "giá 29" = 29k/lạng = 290.000 VND/kg; "giá 32" = 320.000 VND/kg.
  - Nếu đơn giá từ 100 trở lên (ví dụ: "giá 120", "giá 280"), tự hiểu đó là giá tính theo "kg" bằng nghìn đồng. Bạn phải nhân 1.000 để quy ra giá VND/kg. Ví dụ: "giá 120" = 120.000 VND/kg; "giá 250" = 250.000 VND/kg.
  - Nếu người dùng nói rõ ràng đầy đủ đơn giá (ví dụ: "trăm hai", "hai trăm chín chục nghìn", "hai mươi chín nghìn một lạng"), hãy tính đơn giá tương ứng trên mỗi kg.

TRẢ VỀ KẾT QUẢ duy nhất là JSON hợp lệ theo cấu trúc sau, không kèm định dạng markdown hay ký tự bao ngoài.
Ví dụ kết quả:
{
  "date": "2026-06-26T00:00:00.000Z",
  "items": [
    {
      "name": "bắp bò",
      "quantity": 1.0,
      "price": 290000
    }
  ],
  "note": "Lời dịch giọng nói: ngày 26 tháng 6 một cân bắp bò giá hai mươi chín"
}`
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

    // In log ra terminal của Backend để xem kết quả AI nghe và dịch được gì
    console.log('[GEMINI VOICE RESPONSE]', textResponse);

    // Giải mã kết quả JSON trả về từ AI và so khớp sản phẩm
    const parsedData = JSON.parse(textResponse.trim());

    let parsedItems = [];
    let transactionDate = new Date().toISOString();
    let textNote = 'Đơn ghi nợ tạo từ ghi âm giọng nói';

    if (parsedData) {
      if (parsedData.date) {
        transactionDate = parsedData.date;
      }
      if (parsedData.note) {
        textNote = parsedData.note;
      }
      if (Array.isArray(parsedData.items)) {
        parsedItems = parsedData.items;
      }
    }

    // So khớp sản phẩm và đè đơn giá đặc thù từ giọng nói
    const matchedItems = await matchOrCreateProducts(userId, parsedItems);
    const finalItems = matchedItems.map((matchedItem) => {
      const aiItem = parsedItems.find(
        (ai) => ai.name.toLowerCase().trim() === matchedItem.product.name.toLowerCase().trim()
      );
      if (aiItem && aiItem.price && parseFloat(aiItem.price) > 0) {
        return {
          ...matchedItem,
          price: parseFloat(aiItem.price),
        };
      }
      return matchedItem;
    });

    res.status(200).json({
      success: true,
      data: {
        date: transactionDate,
        items: finalItems,
        note: textNote
      }
    });
  } catch (error) {
    console.error('[GEMINI VOICE ERROR]', error);
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
      message: 'Không thể phân tích ghi âm giọng nói: ' + errMsg
    });
  }
};

module.exports = {
  createTransaction,
  getTransactions,
  updateTransaction,
  scanTicket,
  voiceToText,
};
