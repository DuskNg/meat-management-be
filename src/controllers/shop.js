// meat-management-be/src/controllers/shop.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');

// 1. Lấy danh sách bàn kèm phiên chơi đang chạy (nếu có)
const getTables = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const tables = await prisma.shopTable.findMany({
      where: {
        userId,
        isActive: true,
      },
      include: {
        sessions: {
          where: {
            isPaid: false,
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    });

    // Sắp xếp tự nhiên (Natural Sort) để "Bàn 2" đứng trước "Bàn 10"
    tables.sort((a, b) => {
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    res.status(200).json({
      success: true,
      data: tables,
    });
  } catch (error) {
    next(error);
  }
};

// 2. Tạo bàn mới
const createTable = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { name, pricePerHour, tables } = req.body;

    // Hỗ trợ tạo hàng loạt nếu nhận được mảng tables
    if (tables && Array.isArray(tables)) {
      if (tables.length === 0) {
        throw new BadRequestError('Danh sách bàn/phòng trống.');
      }

      // Kiểm tra tính hợp lệ của tất cả phần tử trong mảng
      for (const item of tables) {
        if (!item.name || !item.name.trim()) {
          throw new BadRequestError('Tên của tất cả bàn/phòng phải được điền.');
        }
        const price = parseInt(item.pricePerHour);
        if (isNaN(price) || price < 0) {
          throw new BadRequestError(`Giá tiền của bàn "${item.name}" không hợp lệ.`);
        }
      }

      // Kiểm tra trùng lặp tên bàn trong DB
      const tableNames = tables.map(t => t.name.trim());
      const existing = await prisma.shopTable.findFirst({
        where: {
          userId,
          name: { in: tableNames },
          isActive: true,
        },
      });

      if (existing) {
        throw new BadRequestError(`Bàn/phòng "${existing.name}" đã tồn tại.`);
      }

      // Tạo các bản ghi hàng loạt
      const createdTables = await Promise.all(
        tables.map(item =>
          prisma.shopTable.create({
            data: {
              userId,
              name: item.name.trim(),
              pricePerHour: parseInt(item.pricePerHour),
            },
          })
        )
      );

      await logActivity(userId, 'CREATE_SHOP_TABLES_BULK', `Tạo hàng loạt ${createdTables.length} bàn cửa hàng`);

      return res.status(201).json({
        success: true,
        data: createdTables,
      });
    }

    if (!name || !name.trim()) {
      throw new BadRequestError('Tên bàn/phòng là bắt buộc.');
    }

    const price = parseInt(pricePerHour);
    if (isNaN(price) || price < 0) {
      throw new BadRequestError('Giá tiền mỗi giờ không hợp lệ.');
    }

    // Kiểm tra xem bàn đã tồn tại hay chưa
    const existing = await prisma.shopTable.findFirst({
      where: {
        userId,
        name: name.trim(),
        isActive: true,
      },
    });

    if (existing) {
      throw new BadRequestError('Bàn/phòng này đã tồn tại.');
    }

    const table = await prisma.shopTable.create({
      data: {
        userId,
        name: name.trim(),
        pricePerHour: price,
      },
    });

    await logActivity(userId, 'CREATE_SHOP_TABLE', `Tạo bàn cửa hàng mới: ${table.name} với giá ${price}đ/giờ`);

    res.status(201).json({
      success: true,
      data: table,
    });
  } catch (error) {
    next(error);
  }
};

// 3. Cập nhật thông tin bàn
const updateTable = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { name, pricePerHour } = req.body;

    const table = await prisma.shopTable.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!table) {
      throw new NotFoundError('Bàn/phòng không tồn tại.');
    }

    if (name && name.trim() !== table.name) {
      const existing = await prisma.shopTable.findFirst({
        where: {
          userId,
          name: name.trim(),
          isActive: true,
          id: { not: id },
        },
      });
      if (existing) {
        throw new BadRequestError('Tên bàn/phòng này đã tồn tại.');
      }
    }

    const price = pricePerHour !== undefined ? parseInt(pricePerHour) : undefined;
    if (price !== undefined && (isNaN(price) || price < 0)) {
      throw new BadRequestError('Giá tiền mỗi giờ không hợp lệ.');
    }

    const updatedTable = await prisma.shopTable.update({
      where: { id },
      data: {
        name: name !== undefined ? name.trim() : undefined,
        pricePerHour: price,
      },
    });

    await logActivity(
      userId,
      'UPDATE_SHOP_TABLE',
      `Cập nhật bàn cửa hàng: ${table.name} thành ${updatedTable.name} (giá: ${updatedTable.pricePerHour}đ/giờ)`
    );

    res.status(200).json({
      success: true,
      data: updatedTable,
    });
  } catch (error) {
    next(error);
  }
};

// 4. Xóa bàn (Xóa mềm bằng isActive = false)
const deleteTable = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const table = await prisma.shopTable.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!table) {
      throw new NotFoundError('Bàn/phòng không tồn tại.');
    }

    // Kiểm tra xem bàn có phiên chơi chưa thanh toán không
    const activeSession = await prisma.shopSession.findFirst({
      where: {
        tableId: id,
        isPaid: false,
      },
    });

    if (activeSession) {
      throw new BadRequestError('Không thể xóa bàn đang có khách chơi hoặc chờ thanh toán.');
    }

    await prisma.shopTable.update({
      where: { id },
      data: { isActive: false },
    });

    await logActivity(userId, 'DELETE_SHOP_TABLE', `Xóa bàn cửa hàng: ${table.name}`);

    res.status(200).json({
      success: true,
      message: 'Xóa bàn thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 5. Bắt đầu phiên chơi mới (Bấm bắt đầu)
const startSession = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { tableId } = req.body;

    if (!tableId) {
      throw new BadRequestError('ID bàn là bắt buộc.');
    }

    const table = await prisma.shopTable.findFirst({
      where: {
        id: tableId,
        userId,
        isActive: true,
      },
    });

    if (!table) {
      throw new NotFoundError('Bàn/phòng không tồn tại hoặc đã bị ẩn.');
    }

    // Kiểm tra xem bàn đang có khách chơi chưa thanh toán hay không
    const existingSession = await prisma.shopSession.findFirst({
      where: {
        tableId,
        isPaid: false,
      },
    });

    if (existingSession) {
      throw new BadRequestError('Bàn này đang được sử dụng hoặc chưa thanh toán phiên trước.');
    }

    const session = await prisma.shopSession.create({
      data: {
        tableId,
        userId,
        startTime: new Date(),
      },
    });

    await logActivity(userId, 'START_SHOP_SESSION', `Bắt đầu chơi tại bàn ${table.name}`);

    res.status(201).json({
      success: true,
      data: session,
    });
  } catch (error) {
    next(error);
  }
};

// Helper tính tổng số tiền bao gồm tiền giờ chơi và tiền phụ thu
const calculateSessionTotal = (session, endTimeInput) => {
  const startTime = new Date(session.startTime);
  const endTime = new Date(endTimeInput);
  const playTimeMs = Math.max(0, endTime - startTime);
  const playTimeHours = playTimeMs / (1000 * 60 * 60);
  const totalPlayAmount = Math.round(playTimeHours * session.table.pricePerHour);
  return totalPlayAmount + session.extraAmount;
};

// 6. Kết thúc phiên chơi (Bấm kết thúc) -> tính thời gian và tiền giờ
const endSession = async (req, res, next) => {
  try {
    const { id } = req.params; // Session ID
    const userId = req.user.id;

    const session = await prisma.shopSession.findFirst({
      where: {
        id,
        userId,
        isPaid: false,
      },
      include: {
        table: true,
      },
    });

    if (!session) {
      throw new NotFoundError('Không tìm thấy phiên chơi chưa thanh toán.');
    }

    const endTime = new Date();
    const totalAmount = calculateSessionTotal(session, endTime);

    const updatedSession = await prisma.shopSession.update({
      where: { id },
      data: {
        endTime,
        totalAmount,
      },
      include: {
        table: true,
      },
    });

    await logActivity(
      userId,
      'END_SHOP_SESSION',
      `Kết thúc phiên chơi tại bàn ${session.table.name}. Tổng tiền tạm tính: ${totalAmount}đ`
    );

    res.status(200).json({
      success: true,
      data: updatedSession,
    });
  } catch (error) {
    next(error);
  }
};

// 7. Thêm khoản phụ thu (nước uống, đồ ăn...) vào phiên chơi
const addExtra = async (req, res, next) => {
  try {
    const { id } = req.params; // Session ID
    const userId = req.user.id;
    const { extraAmount, extraNote } = req.body;

    const session = await prisma.shopSession.findFirst({
      where: {
        id,
        userId,
        isPaid: false,
      },
      include: {
        table: true,
      },
    });

    if (!session) {
      throw new NotFoundError('Không tìm thấy phiên chơi.');
    }

    const amount = parseInt(extraAmount);
    if (isNaN(amount) || amount < 0) {
      throw new BadRequestError('Số tiền phụ thu không hợp lệ.');
    }

    // Cập nhật phụ thu và tính toán lại totalAmount
    const tempSession = {
      ...session,
      extraAmount: amount,
    };
    const endTimeToUse = session.endTime || new Date();
    const totalAmount = calculateSessionTotal(tempSession, endTimeToUse);

    const updatedSession = await prisma.shopSession.update({
      where: { id },
      data: {
        extraAmount: amount,
        extraNote: extraNote || null,
        totalAmount,
      },
      include: {
        table: true,
      },
    });

    await logActivity(
      userId,
      'ADD_SHOP_EXTRA',
      `Thêm phụ thu ${amount}đ (${extraNote || 'Không có ghi chú'}) cho bàn ${session.table.name}`
    );

    res.status(200).json({
      success: true,
      data: updatedSession,
    });
  } catch (error) {
    next(error);
  }
};

// 8. Xác nhận thanh toán phiên chơi
const paySession = async (req, res, next) => {
  try {
    const { id } = req.params; // Session ID
    const userId = req.user.id;

    const session = await prisma.shopSession.findFirst({
      where: {
        id,
        userId,
        isPaid: false,
      },
      include: {
        table: true,
      },
    });

    if (!session) {
      throw new NotFoundError('Không tìm thấy phiên chơi.');
    }

    let endTime = session.endTime;
    let totalAmount = session.totalAmount;

    // Nếu chưa bấm Kết thúc mà đã bấm Thanh toán trực tiếp
    if (!endTime) {
      endTime = new Date();
      totalAmount = calculateSessionTotal(session, endTime);
    }

    const updatedSession = await prisma.shopSession.update({
      where: { id },
      data: {
        endTime,
        totalAmount,
        isPaid: true,
        paidAt: new Date(),
      },
      include: {
        table: true,
      },
    });

    await logActivity(
      userId,
      'PAY_SHOP_SESSION',
      `Thanh toán thành công phiên chơi tại bàn ${session.table.name}. Số tiền: ${totalAmount}đ`
    );

    res.status(200).json({
      success: true,
      data: updatedSession,
    });
  } catch (error) {
    next(error);
  }
};

// 9. Lấy tổng doanh thu của phân hệ cửa hàng
const getTotalRevenue = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const aggregations = await prisma.shopSession.aggregate({
      _sum: {
        totalAmount: true,
      },
      where: {
        userId,
        isPaid: true,
      },
    });

    res.status(200).json({
      success: true,
      data: {
        totalRevenue: aggregations._sum.totalAmount || 0,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 10. Lấy doanh thu theo ngày của cửa hàng
const getDailyRevenue = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const sessions = await prisma.shopSession.findMany({
      where: {
        userId,
        isPaid: true,
      },
      select: {
        paidAt: true,
        totalAmount: true,
      },
      orderBy: {
        paidAt: 'desc',
      },
    });

    const dailyMap = {};
    sessions.forEach((s) => {
      if (!s.paidAt) return;
      // Gộp theo ngày (múi giờ GMT)
      const dateKey = s.paidAt.toISOString().split('T')[0];
      dailyMap[dateKey] = (dailyMap[dateKey] || 0) + s.totalAmount;
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

module.exports = {
  getTables,
  createTable,
  updateTable,
  deleteTable,
  startSession,
  endSession,
  addExtra,
  paySession,
  getTotalRevenue,
  getDailyRevenue,
};
