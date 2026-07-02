// meat-management-be/src/controllers/supplier.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError } = require('../utils/errors');

// 1. Lấy toàn bộ danh sách nhà cung cấp kèm theo dư nợ (Tiền nợ)
// Dư nợ = Tổng số tiền transactions (nhập hàng) - Tổng số tiền payments (đã trả)
const getSuppliers = async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Lấy danh sách nhà cung cấp đang hoạt động của chủ sạp
    const suppliers = await prisma.supplier.findMany({
      where: {
        userId,
        isActive: true,
      },
      include: {
        transactions: {
          select: {
            totalAmount: true,
          },
        },
        payments: {
          select: {
            amount: true,
          },
        },
      },
      orderBy: {
        name: 'asc', // Sắp xếp A-Z theo tên nhà cung cấp
      },
    });

    // Tính dư nợ đối với từng nhà cung cấp
    const suppliersWithDebt = suppliers.map((supplier) => {
      const totalDebt = supplier.transactions.reduce((sum, t) => sum + parseFloat(t.totalAmount || 0), 0);
      const totalPaid = supplier.payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
      const debt = totalDebt - totalPaid;

      // Loại bỏ mảng giao dịch con để giảm tải dung lượng mạng
      const { transactions, payments, ...rest } = supplier;
      return {
        ...rest,
        debt,
      };
    });

    res.status(200).json({
      success: true,
      data: suppliersWithDebt,
    });
  } catch (error) {
    next(error);
  }
};

// 2. Tạo mới một nhà cung cấp
const createSupplier = async (req, res, next) => {
  try {
    const { name, phone, address, note } = req.body;
    const userId = req.user.id;

    if (!name || name.trim() === '') {
      throw new BadRequestError('Tên nhà cung cấp là thông tin bắt buộc.');
    }

    const trimmedName = name.trim();

    // Kiểm tra trùng tên nhà cung cấp đang hoạt động
    const existingSupplier = await prisma.supplier.findFirst({
      where: {
        userId,
        name: trimmedName,
        isActive: true,
      },
    });

    if (existingSupplier) {
      throw new BadRequestError('Nhà cung cấp này đã tồn tại trong danh sách của bạn.');
    }

    const supplier = await prisma.supplier.create({
      data: {
        userId,
        name: trimmedName,
        phone: phone ? phone.trim() : null,
        address: address ? address.trim() : null,
        note: note ? note.trim() : null,
      },
    });

    res.status(201).json({
      success: true,
      data: supplier,
    });
  } catch (error) {
    next(error);
  }
};

// 3. Cập nhật thông tin nhà cung cấp
const updateSupplier = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, phone, address, note } = req.body;
    const userId = req.user.id;

    // Kiểm tra sự tồn tại của nhà cung cấp
    const supplierExists = await prisma.supplier.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!supplierExists) {
      throw new NotFoundError('Không tìm thấy nhà cung cấp này hoặc bạn không có quyền sửa.');
    }

    if (name !== undefined) {
      if (!name || name.trim() === '') {
        throw new BadRequestError('Tên nhà cung cấp là thông tin bắt buộc.');
      }
      const trimmedName = name.trim();
      const existingName = await prisma.supplier.findFirst({
        where: {
          userId,
          name: trimmedName,
          isActive: true,
          NOT: { id },
        },
      });

      if (existingName) {
        throw new BadRequestError('Tên nhà cung cấp này đã tồn tại trong danh sách của bạn.');
      }
    }

    const updated = await prisma.supplier.update({
      where: { id },
      data: {
        name: name !== undefined ? name.trim() : undefined,
        phone: phone !== undefined ? (phone ? phone.trim() : null) : undefined,
        address: address !== undefined ? (address ? address.trim() : null) : undefined,
        note: note !== undefined ? (note ? note.trim() : null) : undefined,
      },
    });

    res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

// 4. Xóa mềm nhà cung cấp
const deleteSupplier = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const supplierExists = await prisma.supplier.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!supplierExists) {
      throw new NotFoundError('Không tìm thấy nhà cung cấp này hoặc bạn không có quyền xóa.');
    }

    await prisma.supplier.update({
      where: { id },
      data: {
        isActive: false,
      },
    });

    res.status(200).json({
      success: true,
      message: 'Xóa nhà cung cấp thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 5. Ghi nhận giao dịch nhập hàng (Nợ phát sinh)
const createSupplierTransaction = async (req, res, next) => {
  try {
    const { supplierId, totalAmount, note, date } = req.body;
    const userId = req.user.id;

    if (!supplierId) {
      throw new BadRequestError('supplierId là bắt buộc.');
    }
    if (!totalAmount || parseFloat(totalAmount) <= 0) {
      throw new BadRequestError('Số tiền hàng nhập phải lớn hơn 0.');
    }

    // Kiểm tra nhà cung cấp
    const supplier = await prisma.supplier.findFirst({
      where: {
        id: supplierId,
        userId,
        isActive: true,
      },
    });

    if (!supplier) {
      throw new NotFoundError('Không tìm thấy nhà cung cấp.');
    }

    const transaction = await prisma.supplierTransaction.create({
      data: {
        supplierId,
        totalAmount: parseFloat(totalAmount),
        note: note ? note.trim() : null,
        date: date ? new Date(date) : new Date(),
      },
    });

    res.status(201).json({
      success: true,
      data: transaction,
    });
  } catch (error) {
    next(error);
  }
};

// 6. Ghi nhận thanh toán trả nợ cho nhà cung cấp
const createSupplierPayment = async (req, res, next) => {
  try {
    const { supplierId, amount, note, paidAt } = req.body;
    const userId = req.user.id;

    if (!supplierId) {
      throw new BadRequestError('supplierId là bắt buộc.');
    }
    if (!amount || parseFloat(amount) <= 0) {
      throw new BadRequestError('Số tiền thanh toán phải lớn hơn 0.');
    }

    // Kiểm tra nhà cung cấp
    const supplier = await prisma.supplier.findFirst({
      where: {
        id: supplierId,
        userId,
        isActive: true,
      },
    });

    if (!supplier) {
      throw new NotFoundError('Không tìm thấy nhà cung cấp.');
    }

    const payment = await prisma.supplierPayment.create({
      data: {
        supplierId,
        amount: parseFloat(amount),
        note: note ? note.trim() : null,
        paidAt: paidAt ? new Date(paidAt) : new Date(),
      },
    });

    res.status(201).json({
      success: true,
      data: payment,
    });
  } catch (error) {
    next(error);
  }
};

// 7. Xem lịch sử dòng tiền của một nhà cung cấp (Sắp xếp theo thời gian mới nhất)
const getSupplierHistory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Kiểm tra nhà cung cấp
    const supplier = await prisma.supplier.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!supplier) {
      throw new NotFoundError('Không tìm thấy nhà cung cấp.');
    }

    // Lấy transactions (Nhập hàng / nợ phát sinh)
    const transactions = await prisma.supplierTransaction.findMany({
      where: { supplierId: id },
      orderBy: { date: 'desc' },
    });

    // Lấy payments (Đã thanh toán)
    const payments = await prisma.supplierPayment.findMany({
      where: { supplierId: id },
      orderBy: { paidAt: 'desc' },
    });

    // Gom hai loại thành dòng lịch sử thống nhất
    const historyList = [
      ...transactions.map((t) => ({
        id: t.id,
        type: 'DEBT', // Nợ phát sinh (mình nợ họ)
        amount: parseFloat(t.totalAmount),
        date: t.date,
        note: t.note,
        createdAt: t.createdAt,
      })),
      ...payments.map((p) => ({
        id: p.id,
        type: 'PAYMENT', // Trả nợ (mình trả họ)
        amount: parseFloat(p.amount),
        date: p.paidAt,
        note: p.note,
        createdAt: p.createdAt,
      })),
    ];

    // Sắp xếp theo ngày giao dịch (date), nếu trùng thì xếp theo createdAt mới hơn lên trước
    historyList.sort((a, b) => {
      const dateDiff = new Date(b.date) - new Date(a.date);
      if (dateDiff !== 0) return dateDiff;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    res.status(200).json({
      success: true,
      data: historyList,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  createSupplierTransaction,
  createSupplierPayment,
  getSupplierHistory,
};
