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

    // Lấy song song danh sách khách hàng hoạt động bình thường (loại trừ nợ xấu) và sản phẩm của chủ buôn
    const [customers, products] = await Promise.all([
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
    ]);

    res.json({
      success: true,
      data: {
        linkId: link.id,
        name: link.name,
        ownerName: link.user?.name,
        ownerPhone: link.user?.phone,
        hasPin: Boolean(link.pin),
        customers,
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

/**
 * Áp dụng giá bán riêng mới cho khách hàng và tự động tính lại toàn bộ đơn nợ từ ngày áp dụng về sau
 * [POST] /api/v1/quick-price/public/:token/apply
 */
const applyQuickPriceUpdate = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { customerId, effectiveDate, items, pin } = req.body;

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

          await tx.customerProductPrice.upsert({
            where: {
              customerId_productId: {
                customerId,
                productId: item.productId,
              },
            },
            update: { price: numPrice },
            create: {
              customerId,
              productId: item.productId,
              price: numPrice,
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

      return {
        updatedPricesCount: changedProductIds.length,
        recalculatedCount,
      };
    });

    // 3. Ghi log hoạt động hệ thống
    const formattedDate = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
      startOfEffectiveDate
    );
    const changesSummary = priceDiffs.slice(0, 5).join('; ');
    const moreDiffs = priceDiffs.length > 5 ? `... (+${priceDiffs.length - 5} loại)` : '';
    const logDetail = `Cập nhật giá qua Zalo cho "${customer.name}" từ ngày ${formattedDate} (tính lại ${result.recalculatedCount} đơn nợ):\n• ${changesSummary}${moreDiffs}`;

    await logActivity(
      userId,
      'QUICK_PRICE_APPLY',
      logDetail
    );

    // 4. Phát socket realtime để dashboard của app tự động reload số liệu
    notifyCustomerUpdate(userId, 'UPDATE_CUSTOMER', { customerId });
    emitWorkspaceEvent(userId, 'TRANSACTION_UPDATED', { customerId });

    res.json({
      success: true,
      message: `Đã cập nhật bảng giá và tính lại ${result.recalculatedCount} đơn nợ từ ngày ${formattedDate}!`,
      data: {
        customerName: customer.name,
        updatedPricesCount: result.updatedPricesCount,
        recalculatedCount: result.recalculatedCount,
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
