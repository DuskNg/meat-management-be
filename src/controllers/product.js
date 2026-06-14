// meat-management-be/src/controllers/product.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError } = require('../utils/errors');

// 1. Lấy danh sách sản phẩm hoạt động của chủ buôn đang đăng nhập
const getProducts = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const products = await prisma.product.findMany({
      where: {
        userId,
        isActive: true, // Chỉ lấy các sản phẩm đang hoạt động
      },
      orderBy: {
        name: 'asc', // Sắp xếp theo tên sản phẩm A-Z
      },
    });

    res.status(200).json({
      success: true,
      data: products,
    });
  } catch (error) {
    next(error);
  }
};

// 2. Tạo sản phẩm mới
const createProduct = async (req, res, next) => {
  try {
    const { name, defaultPrice, unit } = req.body;
    const userId = req.user.id;

    if (!name || defaultPrice === undefined) {
      throw new BadRequestError('Tên sản phẩm và giá bán mặc định là bắt buộc.');
    }

    const product = await prisma.product.create({
      data: {
        userId,
        name,
        defaultPrice: parseFloat(defaultPrice),
        unit: unit || 'kg',
      },
    });

    res.status(201).json({
      success: true,
      data: product,
    });
  } catch (error) {
    next(error);
  }
};

// 3. Cập nhật thông tin sản phẩm
const updateProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, defaultPrice, unit } = req.body;
    const userId = req.user.id;

    // Kiểm tra sản phẩm có tồn tại và thuộc chủ buôn này không
    const productExists = await prisma.product.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!productExists) {
      throw new NotFoundError('Không tìm thấy sản phẩm hoặc bạn không có quyền chỉnh sửa.');
    }

    const updatedProduct = await prisma.product.update({
      where: { id },
      data: {
        name: name !== undefined ? name : undefined,
        defaultPrice: defaultPrice !== undefined ? parseFloat(defaultPrice) : undefined,
        unit: unit !== undefined ? unit : undefined,
      },
    });

    res.status(200).json({
      success: true,
      data: updatedProduct,
    });
  } catch (error) {
    next(error);
  }
};

// 4. Xóa mềm sản phẩm (Deactivate)
const deleteProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Kiểm tra sản phẩm có tồn tại và thuộc chủ buôn này không
    const productExists = await prisma.product.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!productExists) {
      throw new NotFoundError('Không tìm thấy sản phẩm hoặc bạn không có quyền xóa.');
    }

    // Ẩn sản phẩm đi bằng cách set isActive = false
    await prisma.product.update({
      where: { id },
      data: {
        isActive: false,
      },
    });

    res.status(200).json({
      success: true,
      message: 'Đã ẩn sản phẩm thành công.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
};
