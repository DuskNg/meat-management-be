// meat-management-be/src/controllers/customer.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError } = require('../utils/errors');

// 1. Lấy toàn bộ danh sách khách hàng của chủ buôn đang đăng nhập
const getCustomers = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const customers = await prisma.customer.findMany({
      where: {
        userId,
        isActive: true, // Chỉ lấy những khách hàng đang hoạt động (chưa bị xóa mềm)
      },
      orderBy: {
        name: 'asc', // Sắp xếp theo thứ tự bảng chữ cái tên khách hàng
      },
    });

    res.status(200).json({
      success: true,
      data: customers,
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
    });

    if (!customer) {
      throw new NotFoundError('Không tìm thấy khách hàng hoặc bạn không có quyền truy cập.');
    }

    res.status(200).json({
      success: true,
      data: customer,
    });
  } catch (error) {
    next(error);
  }
};

// 3. Tạo mới khách hàng
const createCustomer = async (req, res, next) => {
  try {
    const { name, phone, address, note } = req.body;
    const userId = req.user.id;

    if (!name) {
      throw new BadRequestError('Tên khách hàng là thông tin bắt buộc.');
    }

    const customer = await prisma.customer.create({
      data: {
        userId,
        name,
        phone: phone || null,
        address: address || null,
        note: note || null,
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
    const { name, phone, address, note } = req.body;
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

    const updatedCustomer = await prisma.customer.update({
      where: { id },
      data: {
        name: name !== undefined ? name : undefined,
        phone: phone !== undefined ? phone : undefined,
        address: address !== undefined ? address : undefined,
        note: note !== undefined ? note : undefined,
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
