// meat-management-be/src/controllers/scheduledPriceUpdate.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const {
  applySingleScheduledPriceUpdate,
  getVietnamDateKey,
} = require('../schedulers/scheduledPriceUpdateScheduler');

// Chuẩn hóa ngày về dạng YYYY-MM-DD (chấp nhận YYYY-MM-DD hoặc DD/MM/YYYY)
const normalizeTargetDate = (rawDate) => {
  if (!rawDate || typeof rawDate !== 'string') return null;
  const trimmed = rawDate.trim();
  const ymdMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymdMatch) {
    return `${ymdMatch[1]}-${ymdMatch[2].padStart(2, '0')}-${ymdMatch[3].padStart(2, '0')}`;
  }
  const dmyMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmyMatch) {
    return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`;
  }
  return null;
};

// Kiểm tra tên sản phẩm giả lập (không phải loại thịt thật)
const isQuickDebtProductName = (name) => {
  if (!name || typeof name !== 'string') return false;
  const n = name.trim().toLowerCase();
  return n === 'tiền hàng' || n.startsWith('tiền') || n === 'trả hàng nhanh' || n === 'ghi nợ nhanh';
};

// Parse JSON an toàn
const safeParseJSON = (raw, fallback) => {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

// Chuẩn hóa dữ liệu trả về cho Frontend
const formatScheduleRow = (row) => ({
  ...row,
  customerIds: safeParseJSON(row.customerIds, []),
  items: safeParseJSON(row.items, []),
});

/**
 * Lấy danh sách lịch cập nhật giá thịt của chủ buôn
 * GET /api/v1/scheduled-price-updates
 */
const getScheduledPriceUpdates = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId || req.user.id;
    const rows = await prisma.scheduledPriceUpdate.findMany({
      where: { userId },
      orderBy: [{ status: 'desc' }, { targetDate: 'asc' }, { createdAt: 'desc' }],
    });

    res.status(200).json({
      success: true,
      data: rows.map(formatScheduleRow),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Tạo lịch hẹn tự động cập nhật giá thịt
 * POST /api/v1/scheduled-price-updates
 */
const createScheduledPriceUpdate = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId || req.user.id;
    const { targetDate, scope = 'DEFAULT', customerIds = [], items = [], note = '' } = req.body;

    const normalizedDate = normalizeTargetDate(targetDate);
    if (!normalizedDate) {
      throw new BadRequestError('Vui lòng chọn ngày áp dụng hợp lệ.');
    }

    const resolvedScope = scope === 'CUSTOMER' ? 'CUSTOMER' : 'DEFAULT';
    const cleanCustomerIds = resolvedScope === 'CUSTOMER'
      ? [...new Set((Array.isArray(customerIds) ? customerIds : []).filter(Boolean))]
      : [];

    if (resolvedScope === 'CUSTOMER' && cleanCustomerIds.length === 0) {
      throw new BadRequestError('Vui lòng chọn ít nhất 1 khách hàng khi cập nhật giá riêng.');
    }

    const validItems = (Array.isArray(items) ? items : [])
      .filter((it) => it && it.productId && !isNaN(Number(it.newPrice)) && Number(it.newPrice) >= 0 && !isQuickDebtProductName(it.productName))
      .map((it) => ({
        productId: it.productId,
        productName: String(it.productName || '').trim(),
        newPrice: Math.round(Number(it.newPrice)),
      }));

    if (validItems.length === 0) {
      throw new BadRequestError('Vui lòng chọn ít nhất 1 loại thịt và nhập giá mới hợp lệ.');
    }

    const created = await prisma.scheduledPriceUpdate.create({
      data: {
        userId,
        targetDate: normalizedDate,
        scope: resolvedScope,
        customerIds: resolvedScope === 'CUSTOMER' ? JSON.stringify(cleanCustomerIds) : null,
        items: JSON.stringify(validItems),
        note: note ? String(note).trim() : null,
        status: 'PENDING',
      },
    });

    // Nếu ngày áp dụng là hôm nay (hoặc quá khứ), tự động thực thi ngay lập tức
    const todayKey = getVietnamDateKey(new Date());
    let finalRecord = created;
    let appliedImmediately = false;
    if (normalizedDate <= todayKey) {
      finalRecord = await applySingleScheduledPriceUpdate(created);
      appliedImmediately = finalRecord.status === 'APPLIED';
    }

    res.status(201).json({
      success: true,
      message: appliedImmediately
        ? `Đã áp dụng cập nhật giá cho ${validItems.length} loại thịt ngay hôm nay!`
        : `Đã lên lịch tự động cập nhật giá cho ${validItems.length} loại thịt vào ngày ${normalizedDate}.`,
      data: formatScheduleRow(finalRecord),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Cập nhật lại lịch hẹn đang chờ (chỉ sửa được khi PENDING)
 * PUT /api/v1/scheduled-price-updates/:id
 */
const updateScheduledPriceUpdate = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId || req.user.id;
    const { id } = req.params;
    const { targetDate, scope, customerIds, items, note } = req.body;

    const existing = await prisma.scheduledPriceUpdate.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      throw new NotFoundError('Không tìm thấy lịch cập nhật giá.');
    }
    if (existing.status === 'APPLIED') {
      throw new BadRequestError('Lịch này đã được áp dụng nên không thể chỉnh sửa.');
    }

    const normalizedDate = targetDate !== undefined ? normalizeTargetDate(targetDate) : existing.targetDate;
    if (!normalizedDate) {
      throw new BadRequestError('Ngày áp dụng không hợp lệ.');
    }

    const resolvedScope = scope ? (scope === 'CUSTOMER' ? 'CUSTOMER' : 'DEFAULT') : existing.scope;
    const cleanCustomerIds = resolvedScope === 'CUSTOMER'
      ? [...new Set((Array.isArray(customerIds) ? customerIds : safeParseJSON(existing.customerIds, [])).filter(Boolean))]
      : [];

    if (resolvedScope === 'CUSTOMER' && cleanCustomerIds.length === 0) {
      throw new BadRequestError('Vui lòng chọn ít nhất 1 khách hàng khi cập nhật giá riêng.');
    }

    const resolvedItems = items !== undefined
      ? (Array.isArray(items) ? items : [])
          .filter((it) => it && it.productId && !isNaN(Number(it.newPrice)) && Number(it.newPrice) >= 0 && !isQuickDebtProductName(it.productName))
          .map((it) => ({
            productId: it.productId,
            productName: String(it.productName || '').trim(),
            newPrice: Math.round(Number(it.newPrice)),
          }))
      : safeParseJSON(existing.items, []);

    if (resolvedItems.length === 0) {
      throw new BadRequestError('Vui lòng chọn ít nhất 1 loại thịt và nhập giá mới hợp lệ.');
    }

    const updated = await prisma.scheduledPriceUpdate.update({
      where: { id },
      data: {
        targetDate: normalizedDate,
        scope: resolvedScope,
        customerIds: resolvedScope === 'CUSTOMER' ? JSON.stringify(cleanCustomerIds) : null,
        items: JSON.stringify(resolvedItems),
        note: note !== undefined ? (note ? String(note).trim() : null) : existing.note,
        status: 'PENDING',
        errorMessage: null,
      },
    });

    const todayKey = getVietnamDateKey(new Date());
    let finalRecord = updated;
    if (normalizedDate <= todayKey) {
      finalRecord = await applySingleScheduledPriceUpdate(updated);
    }

    res.status(200).json({
      success: true,
      message: 'Đã cập nhật lịch hẹn giá thịt thành công.',
      data: formatScheduleRow(finalRecord),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Áp dụng ngay một lịch đang chờ (trước ngày hẹn)
 * POST /api/v1/scheduled-price-updates/:id/apply-now
 */
const applyNowScheduledPriceUpdate = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId || req.user.id;
    const { id } = req.params;

    const existing = await prisma.scheduledPriceUpdate.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      throw new NotFoundError('Không tìm thấy lịch cập nhật giá.');
    }
    if (existing.status === 'APPLIED') {
      throw new BadRequestError('Lịch này đã được áp dụng trước đó.');
    }

    const applied = await applySingleScheduledPriceUpdate(existing);

    res.status(200).json({
      success: true,
      message: 'Đã áp dụng cập nhật giá thịt ngay thành công!',
      data: formatScheduleRow(applied),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Xóa lịch cập nhật giá thịt
 * DELETE /api/v1/scheduled-price-updates/:id
 */
const deleteScheduledPriceUpdate = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId || req.user.id;
    const { id } = req.params;

    const existing = await prisma.scheduledPriceUpdate.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      throw new NotFoundError('Không tìm thấy lịch cập nhật giá.');
    }

    await prisma.scheduledPriceUpdate.delete({ where: { id } });

    res.status(200).json({
      success: true,
      message: 'Đã xóa lịch cập nhật giá thành công.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getScheduledPriceUpdates,
  createScheduledPriceUpdate,
  updateScheduledPriceUpdate,
  applyNowScheduledPriceUpdate,
  deleteScheduledPriceUpdate,
};
