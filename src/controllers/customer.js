// meat-management-be/src/controllers/customer.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError } = require('../utils/errors');

// 1. Lấy toàn bộ danh sách khách hàng của chủ buôn đang đăng nhập
const getCustomers = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { isBadDebt } = req.query;

    const whereFilter = {
      userId,
      isActive: true, // Chỉ lấy những khách hàng đang hoạt động (chưa bị xóa mềm)
    };

    if (isBadDebt !== undefined) {
      whereFilter.isBadDebt = isBadDebt === 'true';
    } else {
      whereFilter.isBadDebt = false; // Mặc định chỉ lấy khách hàng hoạt động bình thường
    }

    const customers = await prisma.customer.findMany({
      where: whereFilter,
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
        name: 'asc', // Sắp xếp theo thứ tự bảng chữ cái tên khách hàng
      },
    });

    // Tính toán công nợ thực tế cho từng khách hàng
    const dataWithDebt = customers.map((c) => {
      const totalPurchase = c.transactions.reduce((sum, t) => sum + parseFloat(t.totalAmount || 0), 0);
      const totalPaid = c.payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
      // Bao gồm cả manualDebt (số nợ thủ công ban đầu cho khách nợ xấu không có lịch sử giao dịch)
      const debt = totalPurchase - totalPaid + parseFloat(c.manualDebt || 0);

      // Loại bỏ danh sách giao dịch con để giảm tải dung lượng mạng
      const { transactions, payments, ...rest } = c;
      return {
        ...rest,
        debt,
      };
    });

    res.status(200).json({
      success: true,
      data: dataWithDebt,
    });
  } catch (error) {
    next(error);
  }
};

// 2. Lấy chi tiết khách hàng theo ID
const getCustomerById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const customer = await prisma.customer.findFirst({
      where: {
        id,
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
    });

    if (!customer) {
      throw new NotFoundError('Không tìm thấy khách hàng hoặc bạn không có quyền truy cập.');
    }

    const totalPurchase = customer.transactions.reduce((sum, t) => sum + parseFloat(t.totalAmount || 0), 0);
    const totalPaid = customer.payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    // Bao gồm cả manualDebt (số nợ thủ công ban đầu cho khách nợ xấu không có lịch sử giao dịch)
    const debt = totalPurchase - totalPaid + parseFloat(customer.manualDebt || 0);

    const { transactions, payments, ...rest } = customer;

    res.status(200).json({
      success: true,
      data: {
        ...rest,
        debt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 3. Tạo mới khách hàng
const createCustomer = async (req, res, next) => {
  try {
    const { name, phone, address, note, isBadDebt, manualDebt } = req.body;
    const userId = req.user.id;

    if (!name || name.trim() === '') {
      throw new BadRequestError('Tên khách hàng là thông tin bắt buộc.');
    }

    // Validate số tiền nợ ban đầu (nếu có)
    if (manualDebt !== undefined && manualDebt !== null && manualDebt !== '') {
      const debtNum = parseFloat(manualDebt);
      if (isNaN(debtNum) || debtNum < 0) {
        throw new BadRequestError('Số tiền nợ không hợp lệ. Vui lòng nhập số dương.');
      }
    }

    const trimmedName = name.trim();

    // Kiểm tra trùng tên khách hàng (chỉ tính những khách hàng đang hoạt động)
    const existingName = await prisma.customer.findFirst({
      where: {
        userId,
        name: trimmedName,
        isActive: true,
      },
    });

    if (existingName) {
      throw new BadRequestError('Tên khách hàng này đã tồn tại trong danh sách của bạn.');
    }

    // Kiểm tra trùng số điện thoại khách hàng (nếu có nhập)
    if (phone && phone.trim() !== '') {
      const trimmedPhone = phone.trim();
      const existingPhone = await prisma.customer.findFirst({
        where: {
          userId,
          phone: trimmedPhone,
          isActive: true,
        },
      });

      if (existingPhone) {
        throw new BadRequestError('Số điện thoại này đã được sử dụng cho một khách hàng khác của bạn.');
      }
    }

    const customer = await prisma.customer.create({
      data: {
        userId,
        name: trimmedName,
        phone: phone ? phone.trim() : null,
        address: address ? address.trim() : null,
        note: note ? note.trim() : null,
        // Hỗ trợ tạo khách hàng trực tiếp vào kho nợ xấu với số tiền nợ ban đầu
        isBadDebt: isBadDebt === true || isBadDebt === 'true',
        manualDebt: manualDebt ? parseFloat(manualDebt) : 0,
      },
    });

    res.status(201).json({
      success: true,
      data: customer,
    });
  } catch (error) {
    next(error);
  }
};

// 4. Cập nhật thông tin khách hàng
const updateCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, phone, address, note, isBadDebt } = req.body;
    const userId = req.user.id;

    // Kiểm tra khách hàng có tồn tại và thuộc về chủ buôn này hay không
    const customerExists = await prisma.customer.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!customerExists) {
      throw new NotFoundError('Không tìm thấy khách hàng hoặc bạn không có quyền chỉnh sửa.');
    }

    // Kiểm tra trùng tên khách hàng mới nếu có thay đổi tên
    if (name !== undefined) {
      if (!name || name.trim() === '') {
        throw new BadRequestError('Tên khách hàng là thông tin bắt buộc.');
      }
      const trimmedName = name.trim();
      const existingName = await prisma.customer.findFirst({
        where: {
          userId,
          name: trimmedName,
          isActive: true,
          NOT: { id },
        },
      });

      if (existingName) {
        throw new BadRequestError('Tên khách hàng này đã tồn tại trong danh sách của bạn.');
      }
    }

    // Kiểm tra trùng số điện thoại mới nếu có thay đổi số điện thoại
    if (phone !== undefined) {
      const trimmedPhone = phone ? phone.trim() : '';
      if (trimmedPhone !== '') {
        const existingPhone = await prisma.customer.findFirst({
          where: {
            userId,
            phone: trimmedPhone,
            isActive: true,
            NOT: { id },
          },
        });

        if (existingPhone) {
          throw new BadRequestError('Số điện thoại này đã được sử dụng cho một khách hàng khác của bạn.');
        }
      }
    }

    const updatedCustomer = await prisma.customer.update({
      where: { id },
      data: {
        name: name !== undefined ? name.trim() : undefined,
        phone: phone !== undefined ? (phone ? phone.trim() : null) : undefined,
        address: address !== undefined ? (address ? address.trim() : null) : undefined,
        note: note !== undefined ? (note ? note.trim() : null) : undefined,
        isBadDebt: isBadDebt !== undefined ? isBadDebt : undefined,
      },
    });

    res.status(200).json({
      success: true,
      data: updatedCustomer,
    });
  } catch (error) {
    next(error);
  }
};

// 5. Xóa mềm khách hàng (Soft Delete)
const deleteCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Kiểm tra khách hàng có tồn tại và thuộc về chủ buôn này hay không
    const customerExists = await prisma.customer.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!customerExists) {
      throw new NotFoundError('Không tìm thấy khách hàng hoặc bạn không có quyền xóa.');
    }

    // Thực hiện xóa mềm bằng cách cập nhật isActive = false
    await prisma.customer.update({
      where: { id },
      data: {
        isActive: false,
      },
    });

    res.status(200).json({
      success: true,
      message: 'Đã xóa khách hàng thành công.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  deleteCustomer,
};
