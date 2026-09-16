// meat-management-be/src/services/aiInvoiceParser.js
const prisma = require('../utils/db');
const { callGeminiWithRetry } = require('../utils/geminiHelper');
const { emitWorkspaceEvent } = require('../utils/socket');

// Helper loại bỏ dấu tiếng Việt để so khớp tên khách hàng và tên sản phẩm thịt
const removeDiacritics = (str) => {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
};

// Helper tải file từ URL thành base64 để gửi tới Gemini inlineData
const fetchFileAsBase64 = async (url) => {
  if (!url) return null;
  if (url.startsWith('data:')) {
    const [header, data] = url.split(',');
    const mimeMatch = header.match(/data:(.*?);/);
    return {
      mimeType: mimeMatch ? mimeMatch[1] : 'image/jpeg',
      base64Data: data,
    };
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Không thể tải file từ URL: ${url} (Mã lỗi: ${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  return {
    mimeType: contentType.split(';')[0],
    base64Data: buffer.toString('base64'),
  };
};

/**
 * Phân tích hóa đơn / video được gửi từ nhân viên bằng Google Gemini AI
 * @param {string} submissionId - ID bản ghi StaffSubmission cần phân tích
 */
const parseStaffSubmission = async (submissionId) => {
  const submission = await prisma.staffSubmission.findUnique({
    where: { id: submissionId },
    include: {
      user: true,
    },
  });

  if (!submission) {
    console.warn(`[AI_PARSER] Không tìm thấy submissionId: ${submissionId}`);
    return;
  }

  const userId = submission.userId;

  try {
    // 1. Cập nhật trạng thái đang phân tích
    await prisma.staffSubmission.update({
      where: { id: submissionId },
      data: { status: 'ANALYZING', aiError: null },
    });

    emitWorkspaceEvent(userId, 'STAFF_SUBMISSION_ANALYZING', { id: submissionId });

    // 2. Lấy danh sách khách hàng và sản phẩm hiện tại của chủ buôn để làm từ điển đối chiếu cho AI
    const [customers, products] = await Promise.all([
      prisma.customer.findMany({
        where: { userId, isActive: true },
        select: { id: true, name: true, phone: true },
      }),
      prisma.product.findMany({
        where: { userId, isActive: true },
        select: { id: true, name: true, defaultPrice: true, unit: true },
      }),
    ]);

    const customerNamesList = customers.map((c) => c.name).join(', ');
    const productNamesList = products.map((p) => p.name).join(', ');

    // 3. Tải tệp thành Base64
    const filePayload = await fetchFileAsBase64(submission.fileUrl);
    if (!filePayload) {
      throw new Error('Không có dữ liệu tệp hợp lệ để phân tích.');
    }

    const isVideo = submission.fileType === 'VIDEO' || filePayload.mimeType.startsWith('video/');

    // 4. Chuẩn bị prompt AI chuyên sâu: Nếu là Video thì LẮNG NGHE GIỌNG NÓI, nếu là Ảnh thì đọc chữ tích kê
    let promptText = '';

    if (isVideo) {
      promptText = `Bạn là trợ lý AI chuyên nghiệp phân tích VIDEO BÁN THỊT / GIAO THỊT bằng cách LẮNG NGHE GIỌNG NÓI trong video.

DANH SÁCH KHÁCH HÀNG QUEN THUỘC CỦA CHỦ BUÔN:
[${customerNamesList || 'Chưa có'}]

DANH SÁCH CÁC MÓN THỊT THƯỜNG BÁN:
[${productNamesList || 'Chưa có'}]

NHIỆM VỤ QUAN TRỌNG:
Hãy TẬP TRUNG LẮNG NGHE KỸ ÂM THANH / GIỌNG NÓI của người trong video đọc về đơn hàng bán thịt:

1. Xác định Tên khách hàng (customer_name) từ giọng nói:
   - Nghe xem người nói gọi tên ai hoặc giao cho ai (ví dụ: "Chị Lan", "A Hùng phở", "Quán Tuyết", "Bún bò Huế",...).
   - So khớp và chuẩn hóa với danh sách khách hàng quen thuộc ở trên. Nếu không nhắc tên khách hàng, trả về null.

2. Bóc tách chi tiết các mặt hàng thịt (items) từ giọng nói:
   - Tên món thịt (name): Nghe tên loại thịt được đọc (ví dụ: "Thăn", "Nạm", "Gầu", "Xô", "Bắp", "Dẻ", "Sườn", "Ba chỉ", "Xương", "Lạc",...). Cố gắng chuẩn hóa theo danh sách các món thịt ở trên.
   - Khối lượng / Số lượng (quantity): Nghe số lượng/kg người nói đọc (ví dụ: "5 cân" -> 5, "mười cân rưỡi" -> 10.5, "hai phẩy ba cân" -> 2.3, "3 lạng" -> 0.3). Nếu chỉ nói món mà không rõ cân, để 1.
   - Đơn giá (price): Nếu người nói có đọc đơn giá (ví dụ: "giá 240", "trăm tám một cân" -> 180000). Nếu không đọc giá, để null.
   - Thành tiền (amount): Nếu người nói có đọc tổng tiền (ví dụ: "hết năm trăm tư" -> 540000). Nếu không có thì để null.

3. Lưu ý:
   - Người nói có thể dùng khẩu ngữ tiếng Việt (cân = kg, lạng = 0.1kg, rưỡi = .5, chẵn...).
   - Không cần nhìn vào mặt cân điện tử, hãy ưu tiên nghe chính xác lời nói của nhân viên / người bán hàng trong video.

Chỉ trả về JSON theo đúng cấu trúc:
{
  "customer_name": "Tên khách hàng hoặc null",
  "items": [
    {
      "name": "Tên món thịt",
      "quantity": 2.5,
      "price": 240000,
      "amount": 600000
    }
  ]
}`;
    } else {
      promptText = `Bạn là trợ lý AI chuyên nghiệp phân tích hóa đơn bán hàng, tích kê bán thịt viết tay tiếng Việt.

DANH SÁCH KHÁCH HÀNG QUEN THUỘC CỦA CHỦ BUÔN:
[${customerNamesList || 'Chưa có'}]

DANH SÁCH CÁC MÓN THỊT THƯỜNG BÁN:
[${productNamesList || 'Chưa có'}]

NHIỆM VỤ CỦA BẠN:
1. Đọc trường "Tên khách hàng" (customer_name):
   - Thường nằm ở trên đầu tích kê (ví dụ: "Chị Lan", "A Hùng phở", "Bún bò Huế",...).
   - Nếu tên viết tay tương tự một khách hàng trong danh sách quen thuộc ở trên, hãy trả về chính xác tên khách hàng đó.
   - Nếu không có hoặc không đọc được, trả về null.

2. Phân tích chi tiết các mặt hàng thịt (items):
   - Tên mặt hàng (name): Tên loại thịt (ví dụ: "Xô", "Quạt", "Thăn", "Bắp", "Gầu", "Xương", "Lạc", "Nạm", "Dẻ", "Tim",...). Cố gắng chuẩn hóa theo danh sách món thịt thường bán ở trên.
   - Số lượng / Khối lượng (quantity): Số kg hoặc số lượng (ví dụ: "10.5", "2,35" -> 2.35). Nếu trống nhưng có thành tiền, để 1.
   - Đơn giá (price): Đơn giá mỗi kg (VND). Nếu tích kê không ghi đơn giá nhưng có số lượng và thành tiền, hãy tính price = round(amount / quantity). Nếu không có cả giá và thành tiền thì để null.
   - Thành tiền (amount): Số tiền tổng của dòng thịt đó (VND). Tích kê viết tay thường viết tắt hàng nghìn (ví dụ "490" -> 490000, "2.050" hoặc "2050" -> 2050000). Hãy nhân với 1000 nếu thấy viết tắt để ra số tiền thực tế đầy đủ.

Chỉ trả về JSON theo đúng cấu trúc:
{
  "customer_name": "Tên khách hàng hoặc null",
  "items": [
    {
      "name": "Tên món thịt",
      "quantity": 2.5,
      "price": 240000,
      "amount": 600000
    }
  ]
}`;
    }

    // 5. Gọi Gemini API
    const geminiResult = await callGeminiWithRetry({
      contents: [
        {
          parts: [
            { text: promptText },
            {
              inlineData: {
                mimeType: filePayload.mimeType,
                data: filePayload.base64Data,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192,
        responseSchema: {
          type: 'OBJECT',
          properties: {
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
          required: ['items'],
        },
      },
    });

    const parsedJson = JSON.parse(geminiResult.text.trim() || '{}');
    const rawItems = Array.isArray(parsedJson.items) ? parsedJson.items : [];
    const detectedCustomerName = parsedJson.customer_name || null;

    // 6. So khớp khách hàng với danh bạ
    let matchedCustomerId = null;
    if (detectedCustomerName) {
      const cleanDetected = removeDiacritics(detectedCustomerName.toLowerCase().trim());
      const matchedCust = customers.find((c) => {
        const cName = removeDiacritics(c.name.toLowerCase().trim());
        return cName === cleanDetected || cName.includes(cleanDetected) || cleanDetected.includes(cName);
      });
      if (matchedCust) {
        matchedCustomerId = matchedCust.id;
      }
    }

    // 7. Xóa các items cũ nếu có và thêm items mới đã so khớp sản phẩm
    await prisma.staffSubmissionItem.deleteMany({
      where: { submissionId },
    });

    const itemsToCreate = rawItems.map((item) => {
      const rawName = (item.name || 'Thịt lẻ').trim();
      const cleanItemName = removeDiacritics(rawName.toLowerCase());

      // So khớp với danh mục sản phẩm
      let matchedProd = products.find((p) => {
        const pName = removeDiacritics(p.name.toLowerCase().trim());
        return pName === cleanItemName || cleanItemName.includes(pName) || pName.includes(cleanItemName);
      });

      const qty = parseFloat(item.quantity) || null;
      let price = item.price != null ? parseFloat(item.price) : null;
      let amount = item.amount != null ? parseFloat(item.amount) : null;

      // Tự động suy luận giá nếu thiếu
      if (price == null && amount != null && qty != null && qty > 0) {
        price = Math.round(amount / qty);
      } else if (amount == null && price != null && qty != null) {
        amount = Math.round(price * qty);
      } else if (price == null && matchedProd && matchedProd.defaultPrice) {
        price = parseFloat(matchedProd.defaultPrice);
        if (amount == null && qty != null) {
          amount = Math.round(price * qty);
        }
      }

      return {
        submissionId,
        rawName,
        matchedProductId: matchedProd ? matchedProd.id : null,
        quantity: qty,
        price: price,
        amount: amount,
      };
    });

    if (itemsToCreate.length > 0) {
      await prisma.staffSubmissionItem.createMany({
        data: itemsToCreate,
      });
    }

    // 8. Cập nhật trạng thái hoàn thành phân tích
    const updated = await prisma.staffSubmission.update({
      where: { id: submissionId },
      data: {
        status: 'READY_FOR_REVIEW',
        detectedCustomerName,
        matchedCustomerId,
        rawAiResponse: geminiResult.text,
        aiError: null,
      },
      include: {
        items: true,
        matchedCustomer: { select: { id: true, name: true, phone: true } },
      },
    });

    // Bắn realtime thông báo cho chủ buôn
    emitWorkspaceEvent(userId, 'STAFF_SUBMISSION_READY', updated);

    return updated;
  } catch (error) {
    console.error(`[AI_PARSER ERROR] Lỗi phân tích submissionId ${submissionId}:`, error);

    // Dù lỗi AI, vẫn chuyển sang READY_FOR_REVIEW để chủ buôn tự xem ảnh và nhập tay
    await prisma.staffSubmission.update({
      where: { id: submissionId },
      data: {
        status: 'READY_FOR_REVIEW',
        aiError: error.message || 'Lỗi không xác định khi gọi AI',
      },
    });

    emitWorkspaceEvent(userId, 'STAFF_SUBMISSION_FAILED', {
      id: submissionId,
      error: error.message,
    });
  }
};

module.exports = {
  parseStaffSubmission,
};
