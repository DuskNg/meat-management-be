// meat-management-be/src/controllers/scheduledNotification.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError } = require('../utils/errors');

// Chuẩn hóa chuỗi ngày về dạng YYYY-MM-DD (chấp nhận YYYY-MM-DD hoặc DD/MM/YYYY)
const normalizeTargetDate = (rawDate) => {
  if (!rawDate || typeof rawDate !== 'string') return null;
  const trimmed = rawDate.trim();
  const ymdMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymdMatch) {
    const y = ymdMatch[1];
    const m = ymdMatch[2].padStart(2, '0');
    const d = ymdMatch[3].padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const dmyMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmyMatch) {
    const d = dmyMatch[1].padStart(2, '0');
    const m = dmyMatch[2].padStart(2, '0');
    const y = dmyMatch[3];
    return `${y}-${m}-${d}`;
  }
  return null;
};

/**
 * Lấy danh sách thông báo hẹn ngày của người dùng
 * GET /api/v1/scheduled-notifications
 */
const getNotifications = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { targetDate, activeOnly } = req.query;

    const where = { userId };
    if (targetDate) {
      const normalized = normalizeTargetDate(String(targetDate));
      if (normalized) {
        where.targetDate = normalized;
      }
    }
    if (activeOnly === 'true') {
      where.isDismissed = false;
    }

    const notifications = await prisma.scheduledNotification.findMany({
      where,
      orderBy: [{ targetDate: 'asc' }, { createdAt: 'desc' }],
    });

    res.status(200).json({
      success: true,
      data: notifications,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Tạo mới thông báo hẹn ngày
 * POST /api/v1/scheduled-notifications
 */
const createNotification = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { targetDate, content } = req.body;

    const normalizedDate = normalizeTargetDate(targetDate);
    if (!normalizedDate) {
      throw new BadRequestError('Vui lòng chọn ngày hiển thị thông báo hợp lệ.');
    }

    const trimmedContent = typeof content === 'string' ? content.trim() : '';
    if (!trimmedContent) {
      throw new BadRequestError('Vui lòng nhập nội dung thông báo.');
    }
    if (trimmedContent.length > 5000) {
      throw new BadRequestError('Nội dung thông báo tối đa 5.000 ký tự.');
    }

    const created = await prisma.scheduledNotification.create({
      data: {
        userId,
        targetDate: normalizedDate,
        content: trimmedContent,
        isDismissed: false,
      },
    });

    res.status(201).json({
      success: true,
      message: 'Đã tạo thông báo hẹn ngày thành công.',
      data: created,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Cập nhật thông báo hẹn ngày (sửa ngày, nội dung hoặc trạng thái đã xem)
 * PUT /api/v1/scheduled-notifications/:id
 */
const updateNotification = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { targetDate, content, isDismissed } = req.body;

    const existing = await prisma.scheduledNotification.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      throw new NotFoundError('Không tìm thấy thông báo.');
    }

    const updateData = {};
    if (targetDate !== undefined) {
      const normalizedDate = normalizeTargetDate(targetDate);
      if (!normalizedDate) {
        throw new BadRequestError('Ngày hiển thị thông báo không hợp lệ.');
      }
      updateData.targetDate = normalizedDate;
      // Nếu đổi sang ngày mới thì tự động mở lại trạng thái chờ hiển thị
      if (normalizedDate !== existing.targetDate && isDismissed === undefined) {
        updateData.isDismissed = false;
      }
    }

    if (content !== undefined) {
      const trimmedContent = typeof content === 'string' ? content.trim() : '';
      if (!trimmedContent) {
        throw new BadRequestError('Nội dung thông báo không được để trống.');
      }
      if (trimmedContent.length > 5000) {
        throw new BadRequestError('Nội dung thông báo tối đa 5.000 ký tự.');
      }
      updateData.content = trimmedContent;
    }

    if (typeof isDismissed === 'boolean') {
      updateData.isDismissed = isDismissed;
    }

    const updated = await prisma.scheduledNotification.update({
      where: { id },
      data: updateData,
    });

    res.status(200).json({
      success: true,
      message: 'Đã cập nhật thông báo thành công.',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Xóa thông báo hẹn ngày
 * DELETE /api/v1/scheduled-notifications/:id
 */
const deleteNotification = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const existing = await prisma.scheduledNotification.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      throw new NotFoundError('Không tìm thấy thông báo.');
    }

    await prisma.scheduledNotification.delete({
      where: { id },
    });

    res.status(200).json({
      success: true,
      message: 'Đã xóa thông báo thành công.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getNotifications,
  createNotification,
  updateNotification,
  deleteNotification,
};
