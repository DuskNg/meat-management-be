// meat-management-be/src/controllers/inventory.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');

// 1. Lấy danh sách sản phẩm trong kho và tổng giá trị kho
const getInventoryProducts = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const products = await prisma.inventoryProduct.findMany({
      where: {
        userId,
        isActive: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Tính toán thành tiền của từng sản phẩm và tổng giá trị kho
    let totalValue = 0;
    const formattedProducts = products.map((p) => {
      const qty = parseFloat(p.quantity || 0);
      const price = parseFloat(p.price || 0);
      const amount = Math.round(qty * price);
      totalValue += amount;
      return {
        ...p,
        amount,
      };
    });

    res.status(200).json({
      success: true,
      data: {
        products: formattedProducts,
        totalValue,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 2. Thêm sản phẩm mới vào kho
const createInventoryProduct = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { name, quantity, price, unit } = req.body;

    if (!name || !name.trim()) {
      throw new BadRequestError('Tên sản phẩm là bắt buộc.');
    }

    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty < 0) {
      throw new BadRequestError('Số lượng sản phẩm không hợp lệ.');
    }

    const prc = parseFloat(price);
    if (isNaN(prc) || prc < 0) {
      throw new BadRequestError('Giá nhập sản phẩm không hợp lệ.');
    }

    const product = await prisma.inventoryProduct.create({
      data: {
        userId,
        name: name.trim(),
        quantity: qty,
        price: prc,
        unit: unit?.trim() || 'cái',
      },
    });

    await logActivity(userId, 'CREATE_INVENTORY_PRODUCT', `Thêm sản phẩm vào kho: ${product.name} (SL: ${qty}, Giá: ${prc}đ)`);

    res.status(201).json({
      success: true,
      data: product,
    });
  } catch (error) {
    next(error);
  }
};

// 3. Cập nhật thông tin sản phẩm trong kho
const updateInventoryProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { name, quantity, price, unit } = req.body;

    const product = await prisma.inventoryProduct.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!product) {
      throw new NotFoundError('Sản phẩm kho không tồn tại.');
    }

    const qty = quantity !== undefined ? parseFloat(quantity) : undefined;
    if (qty !== undefined && (isNaN(qty) || qty < 0)) {
      throw new BadRequestError('Số lượng sản phẩm không hợp lệ.');
    }

    const prc = price !== undefined ? parseFloat(price) : undefined;
    if (prc !== undefined && (isNaN(prc) || prc < 0)) {
      throw new BadRequestError('Giá nhập sản phẩm không hợp lệ.');
    }

    const updatedProduct = await prisma.inventoryProduct.update({
      where: { id },
      data: {
        name: name !== undefined ? name.trim() : undefined,
        quantity: qty,
        price: prc,
        unit: unit !== undefined ? unit.trim() : undefined,
      },
    });

    await logActivity(userId, 'UPDATE_INVENTORY_PRODUCT', `Cập nhật sản phẩm kho: ${product.name} -> ${updatedProduct.name}`);

    res.status(200).json({
      success: true,
      data: updatedProduct,
    });
  } catch (error) {
    next(error);
  }
};

// 4. Xóa sản phẩm khỏi kho (Xóa mềm)
const deleteInventoryProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const product = await prisma.inventoryProduct.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!product) {
      throw new NotFoundError('Sản phẩm kho không tồn tại.');
    }

    await prisma.inventoryProduct.update({
      where: { id },
      data: { isActive: false },
    });

    await logActivity(userId, 'DELETE_INVENTORY_PRODUCT', `Xóa sản phẩm khỏi kho: ${product.name}`);

    res.status(200).json({
      success: true,
      message: 'Xóa sản phẩm kho thành công.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getInventoryProducts,
  createInventoryProduct,
  updateInventoryProduct,
  deleteInventoryProduct,
};
