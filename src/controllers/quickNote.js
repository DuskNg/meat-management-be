// meat-management-be/src/controllers/quickNote.js
const prisma = require('../utils/db');
const { BadRequestError } = require('../utils/errors');

/**
 * Lấy ghi chú cần nhớ của người dùng hiện tại
 * GET /api/v1/quick-note
 */
const getQuickNote = async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Tìm bản ghi chú gắn với tài khoản chủ buôn
    const note = await prisma.quickNote.findUnique({
      where: { userId },
    });

    res.status(200).json({
      success: true,
      content: note ? note.content : '',
      updatedAt: note ? note.updatedAt : null,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Cập nhật hoặc tạo mới ghi chú cần nhớ của người dùng
 * PUT /api/v1/quick-note
 * Body: { content: string }
 */
const updateQuickNote = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { content } = req.body;

    // Giới hạn độ dài tối đa 50,000 ký tự để tránh lạm dụng bộ nhớ
    if (content && typeof content === 'string' && content.length > 50000) {
      throw new BadRequestError('Nội dung ghi chú vượt quá giới hạn cho phép (tối đa 50.000 ký tự).');
    }

    const noteContent = typeof content === 'string' ? content : '';

    // Cập nhật nếu đã có, hoặc tạo mới nếu chưa có (Upsert)
    const note = await prisma.quickNote.upsert({
      where: { userId },
      update: {
        content: noteContent,
      },
      create: {
        userId,
        content: noteContent,
      },
    });

    res.status(200).json({
      success: true,
      message: 'Đã lưu ghi chú vào hệ thống thành công.',
      content: note.content,
      updatedAt: note.updatedAt,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getQuickNote,
  updateQuickNote,
};
