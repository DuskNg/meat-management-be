// meat-management-be/src/controllers/quickPrice.js
const crypto = require('crypto');
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');
const { emitWorkspaceEvent } = require('../utils/socket');

// Helper sinh chuỗi token ngẫu nhiên an toàn (base64url không chứa ký tự đặc biệt gây lỗi url)
const generateToken = () => {
  return crypto.randomBytes(16).toString('base64url');
};

// Helper phát socket cập nhật realtime cho màn hình chính của ứng dụng
const notifyCustomerUpdate = (userId, action, payload = {}) => {
  emitWorkspaceEvent(userId, 'CUSTOMER_UPDATED', {
    action,
    userId,
    timestamp: new Date().toISOString(),
    ...payload,
  });
};

// Helper chuẩn hóa ngày DD/MM/YYYY hoặc YYYY-MM-DD sang mốc bắt đầu ngày theo múi giờ Việt Nam (UTC+7)
const parseStartOfDayVN = (dateStr) => {
  if (!dateStr) {
    const now = new Date();
    const vnDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(now);
    return new Date(`${vnDateStr}T00:00:00+07:00`);
  }

  if (typeof dateStr === 'string' && dateStr.includes('/')) {
    const [d, m, y] = dateStr.split('/').map(Number);
    const pad = (n) => String(n).padStart(2, '0');
    return new Date(`${y}-${pad(m)}-${pad(d)}T00:00:00+07:00`);
  }

  const rawDate = String(dateStr).split('T')[0];
  return new Date(`${rawDate}T00:00:00+07:00`);
};

// ══════════════════════════════════════════════════════════════════════════════
// 1. CÁC API PUBLIC TRUY CẬP QUA LINK ZALO (KHÔNG CẦN LOGIN APP)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Lấy thông tin cơ bản của link, danh sách khách hàng và danh mục thịt của chủ buôn
 * [GET] /api/v1/quick-price/public/:token
 */
const getPublicLinkInfo = async (req, res, next) => {
  try {
    const { token } = req.params;
    if (!token) throw new BadRequestError('Thiếu mã token truy cập.');

    const link = await prisma.quickPriceLink.findUnique({
      where: { token },
      include: {
        user: { select: { id: true, name: true, phone: true } },
      },
    });

    if (!link || !link.isActive) {
      throw new NotFoundError('Đường dẫn cập nhật giá không tồn tại hoặc đã bị khóa.');
    }

    const userId = link.userId;

    // Lấy song song danh sách khách hàng hoạt động bình thường, sản phẩm và các nhóm khách hàng (PortalLink) của chủ buôn
    const [customers, products, portalLinks] = await Promise.all([
      prisma.customer.findMany({
        where: { userId, isActive: true, isBadDebt: false },
        select: { id: true, name: true, phone: true, address: true },
        orderBy: { name: 'asc' },
      }),
      prisma.product.findMany({
        where: { userId, isActive: true },
        select: { id: true, name: true, defaultPrice: true, costPrice: true, unit: true },
        orderBy: { name: 'asc' },
      }),
      prisma.portalLink.findMany({
        where: { userId, isActive: true, type: 'customer' },
        include: {
          customers: {
            select: { customerId: true },
          },
        },
        orderBy: { name: 'asc' },
      }),
    ]);

    const groups = portalLinks
      .filter((l) => l.customers && l.customers.length >= 2)
      .map((l) => ({
        id: l.id,
        name: l.name,
        customerIds: l.customers.map((c) => c.customerId),
        count: l.customers.length,
      }));

    res.json({
      success: true,
      data: {
        linkId: link.id,
        name: link.name,
        ownerName: link.user?.name,
        ownerPhone: link.user?.phone,
        hasPin: Boolean(link.pin),
        customers,
        groups,
        products: products.map((p) => ({
          id: p.id,
          name: p.name,
          defaultPrice: parseFloat(p.defaultPrice),
          costPrice: parseFloat(p.costPrice || 0),
          unit: p.unit || 'kg',
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Xác thực mã PIN của link (nếu có)
 * [POST] /api/v1/quick-price/public/:token/verify-pin
 */
const verifyLinkPin = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { pin } = req.body;

    const link = await prisma.quickPriceLink.findUnique({
      where: { token },
    });

    if (!link || !link.isActive) {
      throw new NotFoundError('Đường dẫn cập nhật giá không tồn tại hoặc đã bị khóa.');
    }

    if (!link.pin) {
      return res.json({ success: true, message: 'Link không yêu cầu mã PIN.' });
    }

    if (String(link.pin).trim() !== String(pin).trim()) {
      throw new BadRequestError('Mã PIN bảo mật không chính xác.');
    }

    res.json({ success: true, message: 'Xác thực mã PIN thành công.' });
  } catch (error) {
    next(error);
  }
};

/**
 * Lấy danh sách giá riêng hiện có của một khách hàng
 * [GET] /api/v1/quick-price/public/:token/customer-prices/:customerId
 */
const getCustomerPrices = async (req, res, next) => {
  try {
    const { token, customerId } = req.params;
    if (!token || !customerId) throw new BadRequestError('Thiếu thông tin token hoặc khách hàng.');

    const link = await prisma.quickPriceLink.findUnique({
      where: { token },
    });

    if (!link || !link.isActive) {
      throw new NotFoundError('Đường dẫn cập nhật giá không tồn tại hoặc đã bị khóa.');
    }

    // Lấy bảng giá riêng của khách hàng này
    const customPrices = await prisma.customerProductPrice.findMany({
      where: { customerId },
      select: { productId: true, price: true, costPrice: true },
    });

    res.json({
      success: true,
      data: customPrices.map((cp) => ({
        productId: cp.productId,
        price: parseFloat(cp.price),
        costPrice: cp.costPrice ? parseFloat(cp.costPrice) : null,
      })),
    });
  } catch (error) {
    next(error);
  }
};

// Helper chuẩn hóa tên mặt hàng thịt để so khớp không phân biệt dấu và hoa thường
const normalizeMeatName = (str) => {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

// Định dạng số tiền VND hiển thị trong ghi chú
const formatNumberVND = (num) => {
  return new Intl.NumberFormat('vi-VN').format(Math.round(num));
};

// Helper phân tích và tính lại số tiền cho ghi chú đơn trả hàng / nhập hàng
const recalculateReturnPaymentNote = (note, nameToPriceMap) => {
  if (!note || typeof note !== 'string') return null;

  // Bóc tách tiền tố [Trả lại hàng], [Trả hàng nhanh], [Trả hàng], [Nhập hàng]
  const prefixMatch = note.match(/^\[(Trả lại hàng|Trả hàng nhanh|Trả hàng|Nhập hàng)\]\s*/i);
  const prefix = prefixMatch ? prefixMatch[0] : '[Trả lại hàng] ';
  let content = note.slice(prefixMatch ? prefixMatch[0].length : 0).trim();

  if (!content) return null;

  // Tách phần ghi chú phụ ở cuối sau dấu đóng ngoặc tròn cuối cùng (ví dụ: " - NHẬP HÀNG", " - Ghi chú thêm")
  let extraSuffix = '';
  const lastParenIdx = content.lastIndexOf(')');
  let itemsPart = content;

  if (lastParenIdx !== -1) {
    const afterParen = content.substring(lastParenIdx + 1).trim();
    if (afterParen.startsWith('-')) {
      extraSuffix = ' ' + afterParen;
      itemsPart = content.substring(0, lastParenIdx + 1).trim();
    }
  }

  // Tách các món phân cách bởi dấu phẩy
  const itemStrings = itemsPart.split(/,\s*(?=[a-zA-Z\d\u00C0-\u1EF9])/);
  let updatedAny = false;
  let newTotalAmount = 0;
  const newItemsDesc = [];

  for (const part of itemStrings) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Pattern 1: <qty>kg <tên thịt> (<thành tiền>)
    // Ví dụ: '4.3kg Cổ bò (645.000)' hoặc '2.98kg Cổ bò (447.000 đ)'
    const m = trimmed.match(/^(\d+(?:[.,]\d+)?)\s*(?:kg|kilo)?\s+(.+?)(?:\s*\(\s*([\d.,]+)[\s\u00a0]*[đ₫kKVND]?\s*\))?$/i);
    if (m) {
      const qty = parseFloat(m[1].replace(',', '.'));
      let rawProdName = m[2].trim();
      const oldAmt = m[3] ? parseFloat(m[3].replace(/\./g, '').replace(/,/g, '')) : 0;

      const normName = normalizeMeatName(rawProdName);
      let matchedPrice = null;

      if (nameToPriceMap.has(normName)) {
        matchedPrice = nameToPriceMap.get(normName);
      } else {
        for (const [key, p] of nameToPriceMap.entries()) {
          if (normName === key || normName.includes(key) || key.includes(normName)) {
            matchedPrice = p;
            break;
          }
        }
      }

      if (matchedPrice !== null && !isNaN(qty) && qty > 0) {
        const itemNewAmt = Math.round(qty * matchedPrice);
        newItemsDesc.push(`${qty}kg ${rawProdName} (${formatNumberVND(itemNewAmt)})`);
        newTotalAmount += itemNewAmt;
        updatedAny = true;
      } else {
        newItemsDesc.push(trimmed);
        newTotalAmount += oldAmt;
      }
    } else {
      // Pattern 2: Dạng nhập nhanh: <tên thịt> <đơn giá> <số lượng>[kg]
      const quickMatch = trimmed.match(/^([a-zA-ZÀ-ỹ\s()+-]+?)\s+(\d+(?:[.,]\d+)?\s*[kK]?)\s+([\d]+(?:[.,]\d+)?)\s*(?:kg|kilo)?$/i);
      if (quickMatch) {
        let rawProdName = quickMatch[1].trim();
        const normName = normalizeMeatName(rawProdName);
        let matchedPrice = null;
        if (nameToPriceMap.has(normName)) {
          matchedPrice = nameToPriceMap.get(normName);
        } else {
          for (const [key, p] of nameToPriceMap.entries()) {
            if (normName === key || normName.includes(key) || key.includes(normName)) {
              matchedPrice = p;
              break;
            }
          }
        }

        const qty = parseFloat(quickMatch[3].trim().replace(',', '.'));
        if (matchedPrice !== null && !isNaN(qty) && qty > 0) {
          const itemNewAmt = Math.round(qty * matchedPrice);
          newItemsDesc.push(`${qty}kg ${rawProdName} (${formatNumberVND(itemNewAmt)})`);
          newTotalAmount += itemNewAmt;
          updatedAny = true;
        } else {
          newItemsDesc.push(trimmed);
        }
      } else {
        newItemsDesc.push(trimmed);
      }
    }
  }

  if (!updatedAny) return null;

  const newNote = `${prefix}${newItemsDesc.join(', ')}${extraSuffix}`;
  return { newNote, newTotalAmount };
};

/**
 * Áp dụng giá bán riêng mới cho khách hàng và tự động tính lại toàn bộ đơn nợ, trả hàng, nhập hàng từ ngày áp dụng về sau
 * [POST] /api/v1/quick-price/public/:token/apply
 */
const applyQuickPriceUpdate = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { customerId, effectiveDate, items, pin, changeReason } = req.body;

    if (!token) throw new BadRequestError('Thiếu mã token truy cập.');
    if (!customerId) throw new BadRequestError('Vui lòng chọn khách hàng.');
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestError('Vui lòng cung cấp danh sách mặt hàng cần điều chỉnh giá.');
    }

    const link = await prisma.quickPriceLink.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!link || !link.isActive) {
      throw new NotFoundError('Đường dẫn cập nhật giá không tồn tại hoặc đã bị khóa.');
    }

    // Kiểm tra mã PIN nếu link có yêu cầu
    if (link.pin && String(link.pin).trim() !== String(pin).trim()) {
      throw new ForbiddenError('Mã PIN không đúng hoặc chưa được xác thực.');
    }

    const userId = link.userId;

    // Kiểm tra khách hàng có thuộc chủ buôn này không
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, userId, isActive: true },
    });

    if (!customer) {
      throw new NotFoundError('Không tìm thấy khách hàng hoặc khách hàng đã ngừng hoạt động.');
    }

    // Xác định mốc thời gian bắt đầu ngày áp dụng (00:00:00 múi giờ Việt Nam UTC+7)
    const startOfEffectiveDate = parseStartOfDayVN(effectiveDate);

    // Chuẩn bị danh sách cập nhật giá và đổi tên thịt
    const changedProductIds = [];
    const changedPriceMap = new Map(); // productId -> newPrice

    const prodIds = items.map((it) => it.productId).filter(Boolean);
    const existingCustomPrices = await prisma.customerProductPrice.findMany({
      where: { customerId, productId: { in: prodIds } },
    });
    const allProds = await prisma.product.findMany({
      where: { id: { in: prodIds }, userId },
      select: { id: true, name: true, defaultPrice: true },
    });
    const prodMap = new Map(allProds.map((p) => [p.id, p]));
    const oldPriceMap = new Map(existingCustomPrices.map((cp) => [cp.productId, cp.price]));
    const priceDiffs = [];

    // Một lần cập nhật có thể phải tính lại nhiều đơn nợ và đơn trả hàng của khách hàng.
    // Timeout mặc định 5 giây quá ngắn, đặc biệt khi áp dụng bảng giá cho nhóm
    // nhiều nhà hàng, khiến transaction bị hết hạn giữa chừng và trả về HTTP 500.
    const result = await prisma.$transaction(async (tx) => {
      // 1. Cập nhật tên thịt và giá riêng vào bảng CustomerProductPrice
      for (const item of items) {
        if (!item.productId) continue;

        const prod = prodMap.get(item.productId);
        const oldPriceVal = oldPriceMap.get(item.productId);
        const oldPriceStr = oldPriceVal !== undefined && oldPriceVal !== null
          ? `${Number(oldPriceVal).toLocaleString('vi-VN')}đ`
          : `Mặc định (${Number(prod?.defaultPrice || 0).toLocaleString('vi-VN')}đ)`;
        const newPriceStr = item.resetToDefault || item.price === null
          ? `Về mặc định (${Number(prod?.defaultPrice || 0).toLocaleString('vi-VN')}đ)`
          : `${Number(item.price).toLocaleString('vi-VN')}đ`;
        priceDiffs.push(`${prod?.name || 'Thịt'} (Trước: ${oldPriceStr} ➔ Sau: ${newPriceStr})`);

        // Nếu có sửa tên thịt, cập nhật trực tiếp tên sản phẩm Product
        if (item.productName && typeof item.productName === 'string') {
          const trimmedName = item.productName.trim();
          if (trimmedName) {
            await tx.product.update({
              where: { id: item.productId, userId },
              data: { name: trimmedName },
            });
          }
        }

        // Xử lý giá riêng
        if (item.resetToDefault || item.price === null) {
          // Khôi phục về giá niêm yết mặc định
          await tx.customerProductPrice.deleteMany({
            where: { customerId, productId: item.productId },
          });

          // Lấy giá mặc định của sản phẩm để tính lại đơn nợ
          const prod = await tx.product.findUnique({
            where: { id: item.productId },
            select: { defaultPrice: true },
          });
          if (prod) {
            const defPrice = parseFloat(prod.defaultPrice);
            changedPriceMap.set(item.productId, defPrice);
            changedProductIds.push(item.productId);
          }
        } else {
          const numPrice = parseFloat(item.price);
          if (isNaN(numPrice) || numPrice < 0) continue;

          const effectiveReason = item.changeReason !== undefined
            ? (item.changeReason?.trim() || null)
            : (changeReason !== undefined ? (changeReason?.trim() || null) : undefined);

          await tx.customerProductPrice.upsert({
            where: {
              customerId_productId: {
                customerId,
                productId: item.productId,
              },
            },
            update: {
              price: numPrice,
              ...(effectiveReason !== undefined ? { changeReason: effectiveReason } : {}),
            },
            create: {
              customerId,
              productId: item.productId,
              price: numPrice,
              changeReason: effectiveReason || null,
            },
          });

          changedPriceMap.set(item.productId, numPrice);
          changedProductIds.push(item.productId);
        }
      }

      // 2. Tự động tính lại toàn bộ đơn nợ TỪ NGÀY ÁP DỤNG TRỞ VỀ SAU (date >= startOfEffectiveDate)
      // CÁC ĐƠN TRƯỚC NGÀY ÁP DỤNG TUYỆT ĐỐI GIỮ NGUYÊN 100%
      let recalculatedCount = 0;

      if (changedProductIds.length > 0) {
        // Tìm các đơn nợ có chứa ít nhất một sản phẩm thay đổi giá và phát sinh từ ngày áp dụng về sau
        const affectedTransactions = await tx.transaction.findMany({
          where: {
            userId,
            customerId,
            date: { gte: startOfEffectiveDate },
            items: {
              some: { productId: { in: changedProductIds } },
            },
          },
          include: { items: true },
        });

        for (const trans of affectedTransactions) {
          let hasItemUpdated = false;

          // Cập nhật lại từng dòng chi tiết đơn nợ
          for (const it of trans.items) {
            if (changedPriceMap.has(it.productId)) {
              const newPrice = changedPriceMap.get(it.productId);
              const qty = parseFloat(it.quantity || 0);
              const cost = parseFloat(it.costPrice || 0);
              const newAmount = Math.round(qty * newPrice);
              const newProfit = newAmount - Math.round(qty * cost);

              await tx.transactionItem.update({
                where: { id: it.id },
                data: {
                  price: newPrice,
                  amount: newAmount,
                  profit: newProfit,
                },
              });
              hasItemUpdated = true;
            }
          }

          if (hasItemUpdated) {
            // Lấy lại danh sách mặt hàng sau khi cập nhật để tính lại tổng tiền đơn nợ
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

            // Xử lý đơn có cấu hình riêng % lợi nhuận
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

            recalculatedCount++;
          }
        }
      }

      // 3. Tự động tính lại toàn bộ đơn TRẢ HÀNG & NHẬP HÀNG (Payment) TỪ NGÀY ÁP DỤNG TRỞ VỀ SAU (paidAt >= startOfEffectiveDate)
      let recalculatedPaymentsCount = 0;

      if (changedProductIds.length > 0) {
        // Chuẩn bị Map tên chuẩn hóa -> đơn giá mới
        const nameToPriceMap = new Map();
        for (const [prodId, newP] of changedPriceMap.entries()) {
          const pObj = prodMap.get(prodId);
          if (pObj?.name) {
            nameToPriceMap.set(normalizeMeatName(pObj.name), newP);
          }
        }
        for (const it of items) {
          if (it.productName && changedPriceMap.has(it.productId)) {
            nameToPriceMap.set(normalizeMeatName(it.productName), changedPriceMap.get(it.productId));
          }
        }

        // Tìm tất cả các Payment của khách hàng phát sinh từ ngày áp dụng về sau
        const candidatePayments = await tx.payment.findMany({
          where: {
            customerId,
            paidAt: { gte: startOfEffectiveDate },
          },
        });

        for (const pm of candidatePayments) {
          const noteText = pm.note || '';
          const isReturnOrImport =
            noteText.includes('[Trả lại hàng]') ||
            noteText.includes('[Trả hàng nhanh]') ||
            noteText.includes('[Trả hàng]') ||
            noteText.includes('[Nhập hàng]') ||
            /\b(trả hàng|gửi về|trả về|trả lại|nhập hàng|nhập thịt|nhap hang|nhap thit)\b/i.test(noteText);

          if (!isReturnOrImport) continue;

          // Kiểm tra xem đơn này có StaffSubmission liên kết hay không
          const linkedSubmission = await tx.staffSubmission.findFirst({
            where: { transactionId: pm.id },
            include: { items: true },
          });

          let hasUpdated = false;

          if (linkedSubmission && linkedSubmission.items && linkedSubmission.items.length > 0) {
            let hasItemChanged = false;
            for (const subItem of linkedSubmission.items) {
              let newP = null;
              const pId = subItem.productId || subItem.matchedProductId;
              if (pId && changedPriceMap.has(pId)) {
                newP = changedPriceMap.get(pId);
              } else if (subItem.rawName) {
                const norm = normalizeMeatName(subItem.rawName);
                if (nameToPriceMap.has(norm)) {
                  newP = nameToPriceMap.get(norm);
                } else {
                  for (const [k, pVal] of nameToPriceMap.entries()) {
                    if (norm === k || norm.includes(k) || k.includes(norm)) {
                      newP = pVal;
                      break;
                    }
                  }
                }
              }

              if (newP !== null) {
                const q = parseFloat(subItem.quantity || 0);
                const newAmt = Math.round(q * newP);
                await tx.staffSubmissionItem.update({
                  where: { id: subItem.id },
                  data: {
                    price: newP,
                    amount: newAmt,
                  },
                });
                hasItemChanged = true;
              }
            }

            if (hasItemChanged) {
              const allSubItems = await tx.staffSubmissionItem.findMany({
                where: { submissionId: linkedSubmission.id },
              });
              const subTotal = allSubItems.reduce((sum, si) => sum + (parseFloat(si.amount) || 0), 0);

              // Cập nhật lại chuỗi ghi chú của submission và payment
              const itemsDesc = allSubItems
                .map((it) => {
                  const q = it.quantity != null && parseFloat(it.quantity) > 0 ? `${it.quantity}kg ` : '';
                  const n = it.rawName || 'Thịt';
                  const a = it.amount != null ? `(${formatNumberVND(it.amount)})` : '';
                  return `${q}${n} ${a}`.trim();
                })
                .filter(Boolean)
                .join(', ');

              let cleanExtra = (linkedSubmission.note || '')
                .replace(/\[Trả lại hàng\]|\[Trả hàng nhanh\]|\[Trả hàng\]|\[Nhập hàng\]/gi, '')
                .trim();
              if (cleanExtra.includes('(') && cleanExtra.includes(')')) {
                const lp = cleanExtra.lastIndexOf(')');
                cleanExtra = cleanExtra.substring(lp + 1).replace(/^[-–—:\s]+/, '').trim();
              }

              const newNote = cleanExtra
                ? `[Trả lại hàng] ${itemsDesc} - ${cleanExtra}`
                : `[Trả lại hàng] ${itemsDesc}`;

              await tx.staffSubmission.update({
                where: { id: linkedSubmission.id },
                data: {
                  note: newNote,
                },
              });

              await tx.payment.update({
                where: { id: pm.id },
                data: {
                  amount: subTotal,
                  note: newNote,
                },
              });

              hasUpdated = true;
            }
          }

          // Nếu chưa cập nhật qua StaffSubmission, phân tích trực tiếp ghi chú Payment.note
          if (!hasUpdated && noteText) {
            const recalcResult = recalculateReturnPaymentNote(noteText, nameToPriceMap);
            if (recalcResult && recalcResult.newTotalAmount > 0) {
              await tx.payment.update({
                where: { id: pm.id },
                data: {
                  amount: recalcResult.newTotalAmount,
                  note: recalcResult.newNote,
                },
              });
              hasUpdated = true;
            }
          }

          if (hasUpdated) {
            recalculatedPaymentsCount++;
          }
        }
      }

      return {
        updatedPricesCount: changedProductIds.length,
        recalculatedCount,
        recalculatedPaymentsCount,
      };
    }, {
      maxWait: 10000,
      timeout: 30000,
    });

    // 4. Ghi log hoạt động hệ thống
    const formattedDate = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
      startOfEffectiveDate
    );
    const changesSummary = priceDiffs.slice(0, 5).join('; ');
    const moreDiffs = priceDiffs.length > 5 ? `... (+${priceDiffs.length - 5} loại)` : '';
    const logDetail = `Cập nhật giá qua Zalo cho "${customer.name}" từ ngày ${formattedDate} (tính lại ${result.recalculatedCount} đơn nợ, ${result.recalculatedPaymentsCount} đơn trả hàng/nhập hàng):\n• ${changesSummary}${moreDiffs}`;

    await logActivity(
      userId,
      'QUICK_PRICE_APPLY',
      logDetail
    );

    // 5. Phát socket realtime để dashboard của app tự động reload số liệu
    notifyCustomerUpdate(userId, 'UPDATE_CUSTOMER', { customerId });
    emitWorkspaceEvent(userId, 'TRANSACTION_UPDATED', { customerId });
    emitWorkspaceEvent(userId, 'PAYMENT_UPDATED', { customerId });

    const totalRecalc = result.recalculatedCount + result.recalculatedPaymentsCount;
    let detailMsg = `Đã cập nhật bảng giá và tính lại ${result.recalculatedCount} đơn bán hàng`;
    if (result.recalculatedPaymentsCount > 0) {
      detailMsg += `, ${result.recalculatedPaymentsCount} đơn trả hàng/nhập hàng`;
    }
    detailMsg += ` từ ngày ${formattedDate}!`;

    res.json({
      success: true,
      message: detailMsg,
      data: {
        customerName: customer.name,
        updatedPricesCount: result.updatedPricesCount,
        recalculatedCount: totalRecalc,
        recalculatedTransactionsCount: result.recalculatedCount,
        recalculatedPaymentsCount: result.recalculatedPaymentsCount,
        effectiveDateFormatted: formattedDate,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// 2. CÁC API DÀNH CHO APP CHÍNH (CẦN LOGIN & RESOLVE WORKSPACE)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Lấy link Zalo cập nhật giá của chủ buôn (tự động tạo nếu chưa có)
 * [GET] /api/v1/quick-price/manage/link
 */
const getOwnerQuickPriceLink = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;

    let link = await prisma.quickPriceLink.findFirst({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!link) {
      link = await prisma.quickPriceLink.create({
        data: {
          userId,
          name: 'Link Zalo Cập Nhật Giá Bán Nhanh',
          token: generateToken(),
          isActive: true,
        },
      });
    }

    res.json({
      success: true,
      data: {
        id: link.id,
        name: link.name,
        token: link.token,
        hasPin: Boolean(link.pin),
        pin: link.pin || null,
        isActive: link.isActive,
        createdAt: link.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Thu hồi và tạo mới token cho link Zalo cập nhật giá
 * [POST] /api/v1/quick-price/manage/regenerate
 */
const regenerateOwnerQuickPriceLink = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { pin } = req.body;

    let link = await prisma.quickPriceLink.findFirst({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    const newToken = generateToken();

    if (link) {
      link = await prisma.quickPriceLink.update({
        where: { id: link.id },
        data: {
          token: newToken,
          ...(pin !== undefined ? { pin: pin ? String(pin).trim() : null } : {}),
        },
      });
    } else {
      link = await prisma.quickPriceLink.create({
        data: {
          userId,
          name: 'Link Zalo Cập Nhật Giá Bán Nhanh',
          token: newToken,
          pin: pin ? String(pin).trim() : null,
          isActive: true,
        },
      });
    }

    await logActivity(userId, 'REGENERATE_QUICK_PRICE_LINK', `Đã tạo mới mã link Zalo cập nhật giá.`);

    res.json({
      success: true,
      message: 'Đã tạo mới mã link Zalo thành công.',
      data: {
        id: link.id,
        name: link.name,
        token: link.token,
        hasPin: Boolean(link.pin),
        pin: link.pin || null,
        isActive: link.isActive,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Cập nhật cấu hình link (đổi tên, mã PIN)
 * [PUT] /api/v1/quick-price/manage/link/:id
 */
const updateOwnerQuickPriceLink = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;
    const { name, pin } = req.body;

    const link = await prisma.quickPriceLink.findFirst({
      where: { id, userId },
    });

    if (!link) throw new NotFoundError('Không tìm thấy link cập nhật giá.');

    const updated = await prisma.quickPriceLink.update({
      where: { id },
      data: {
        ...(name ? { name: name.trim() } : {}),
        pin: pin ? String(pin).trim() : null,
      },
    });

    res.json({
      success: true,
      message: 'Cập nhật thông tin link thành công.',
      data: {
        id: updated.id,
        name: updated.name,
        token: updated.token,
        hasPin: Boolean(updated.pin),
        pin: updated.pin || null,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getPublicLinkInfo,
  verifyLinkPin,
  getCustomerPrices,
  applyQuickPriceUpdate,
  getOwnerQuickPriceLink,
  regenerateOwnerQuickPriceLink,
  updateOwnerQuickPriceLink,
};
