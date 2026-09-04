// meat-management-be/src/controllers/product.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');

// 1. Lấy danh sách sản phẩm hoạt động của chủ buôn đang đăng nhập (hỗ trợ lấy giá riêng theo khách hàng)
const getProducts = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { customerId } = req.query;

    const products = await prisma.product.findMany({
      where: {
        userId,
        isActive: true, // Chỉ lấy các sản phẩm đang hoạt động
      },
      orderBy: {
        name: 'asc', // Sắp xếp theo tên sản phẩm A-Z
      },
    });

    // Nếu có customerId, lấy giá bán riêng của khách hàng này để ghi đè lên giá chung mặc định
    if (customerId) {
      const customPrices = await prisma.customerProductPrice.findMany({
        where: {
          customerId,
        },
      });

      const priceMap = new Map(
        customPrices.map((cp) => [cp.productId, { price: cp.price, costPrice: cp.costPrice }])
      );

      const customProducts = products.map((p) => {
        if (priceMap.has(p.id)) {
          const cp = priceMap.get(p.id);
          return {
            ...p,
            defaultPrice: cp.price !== undefined && cp.price !== null ? cp.price : p.defaultPrice,
            costPrice: cp.costPrice !== undefined && cp.costPrice !== null ? cp.costPrice : p.costPrice,
          };
        }
        return p;
      });

      return res.status(200).json({
        success: true,
        data: customProducts,
      });
    }

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
    const { name, defaultPrice, costPrice, unit } = req.body;
    const userId = req.effectiveUserId;

    if (!name || defaultPrice === undefined) {
      throw new BadRequestError('Tên sản phẩm và giá bán mặc định là bắt buộc.');
    }

    const product = await prisma.product.create({
      data: {
        userId,
        createdBy: req.user.id,
        name,
        defaultPrice: parseFloat(defaultPrice),
        costPrice: costPrice !== undefined ? parseFloat(costPrice) : 0,
        unit: unit || 'kg',
      },
    });

    // Ghi log hoạt động
    await logActivity(
      userId,
      'CREATE_PRODUCT',
      `Tạo sản phẩm mới: ${product.name} (Giá bán: ${Number(product.defaultPrice).toLocaleString('vi-VN')}đ, Giá nhập: ${Number(product.costPrice).toLocaleString('vi-VN')}đ/${product.unit})`
    );

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
    const { name, defaultPrice, costPrice, unit } = req.body;
    const userId = req.effectiveUserId;

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
        costPrice: costPrice !== undefined ? parseFloat(costPrice) : undefined,
        unit: unit !== undefined ? unit : undefined,
      },
    });

    // Ghi log hoạt động
    await logActivity(
      userId,
      'UPDATE_PRODUCT',
      `Cập nhật sản phẩm: ${productExists.name} (Giá bán: ${Number(productExists.defaultPrice).toLocaleString('vi-VN')}đ, Giá nhập: ${Number(productExists.costPrice).toLocaleString('vi-VN')}đ) -> ${updatedProduct.name} (Giá bán: ${Number(updatedProduct.defaultPrice).toLocaleString('vi-VN')}đ, Giá nhập: ${Number(updatedProduct.costPrice).toLocaleString('vi-VN')}đ)`
    );

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
    const userId = req.effectiveUserId;

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

    // Kiểm tra bảo vệ dữ liệu chéo: Nhân viên chỉ được xóa dữ liệu do chính mình tạo. Chủ Workspace và Admin tối cao có toàn quyền.
    const actorId = req.user.id;
    const actorIsAdmin = req.user.isAdmin === true;
    if (!actorIsAdmin && productExists.createdBy !== actorId && actorId !== productExists.userId) {
      throw new ForbiddenError('Tài khoản của bạn không có quyền xóa dữ liệu do người khác tạo.');
    }

    // Ẩn sản phẩm đi bằng cách set isActive = false
    await prisma.product.update({
      where: { id },
      data: {
        isActive: false,
      },
    });

    // Ghi log hoạt động
    await logActivity(
      userId,
      'DELETE_PRODUCT',
      `Ẩn sản phẩm: ${productExists.name} (Giá mặc định: ${Number(productExists.defaultPrice).toLocaleString('vi-VN')}đ/${productExists.unit})`
    );

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
