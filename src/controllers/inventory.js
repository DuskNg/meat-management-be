// meat-management-be/src/controllers/inventory.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');
const { emitWorkspaceEvent } = require('../utils/socket');

// Helper gửi socket event thông báo kho hàng thay đổi
const notifyInventoryUpdate = (userId, action, payload = {}) => {
  emitWorkspaceEvent(userId, 'INVENTORY_UPDATED', {
    action,
    userId,
    timestamp: new Date().toISOString(),
    ...payload,
  });
};

// 1. Lấy danh sách sản phẩm trong kho và tổng giá trị kho
const getInventoryProducts = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const products = await prisma.inventoryProduct.findMany({
      where: {
        userId,
        isActive: true,
      },
      include: {
        logs: {
          where: { type: 'OUT' },
          select: { quantity: true },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Tính toán thành tiền của từng sản phẩm và tổng giá trị kho, trạng thái cảnh báo tồn
    let totalValue = 0;
    const formattedProducts = products.map((p) => {
      const qty = parseFloat(p.quantity || 0);
      const minQty = parseFloat(p.minQuantity || 0);
      const price = parseFloat(p.price || 0);
      const amount = Math.round(qty * price);
      totalValue += amount;

      // Tính tổng số lượng đã sử dụng / xuất kho
      const usedQuantity = (p.logs || []).reduce(
        (sum, log) => sum + parseFloat(log.quantity || 0),
        0
      );

      const isOutOfStock = qty <= 0;
      const isLowStock = !isOutOfStock && minQty > 0 && qty <= minQty;

      const { logs, ...rest } = p;

      return {
        ...rest,
        quantity: qty,
        usedQuantity,
        minQuantity: minQty,
        price,
        amount,
        isOutOfStock,
        isLowStock,
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
    const userId = req.effectiveUserId;
    const { name, quantity, minQuantity, price, unit } = req.body;

    if (!name || !name.trim()) {
      throw new BadRequestError('Tên sản phẩm là bắt buộc.');
    }

    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty < 0) {
      throw new BadRequestError('Số lượng sản phẩm không hợp lệ.');
    }

    const minQty = minQuantity !== undefined ? parseFloat(minQuantity) : 0;
    if (isNaN(minQty) || minQty < 0) {
      throw new BadRequestError('Định mức tồn tối thiểu không hợp lệ.');
    }

    const prc = parseFloat(price);
    if (isNaN(prc) || prc < 0) {
      throw new BadRequestError('Giá nhập sản phẩm không hợp lệ.');
    }

    const product = await prisma.inventoryProduct.create({
      data: {
        userId,
        createdBy: req.user.id,
        name: name.trim(),
        quantity: qty,
        minQuantity: minQty,
        price: prc,
        unit: unit?.trim() || 'cái',
      },
    });

    // Nếu tạo sản phẩm với số lượng ban đầu > 0, tự động ghi log nhập kho ban đầu
    if (qty > 0) {
      await prisma.inventoryLog.create({
        data: {
          userId,
          productId: product.id,
          createdBy: req.user.id,
          type: 'IN',
          quantity: qty,
          price: prc,
          previousQty: 0,
          newQty: qty,
          reason: 'Khởi tạo sản phẩm ban đầu',
        },
      });
    }

    await logActivity(userId, 'CREATE_INVENTORY_PRODUCT', `Thêm sản phẩm vào kho: ${product.name} (SL: ${qty}, Giá: ${prc}đ)`);
    notifyInventoryUpdate(userId, 'CREATE_INVENTORY_PRODUCT', { productId: product.id });

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
    const userId = req.effectiveUserId;
    const { name, quantity, minQuantity, price, unit } = req.body;

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

    const minQty = minQuantity !== undefined ? parseFloat(minQuantity) : undefined;
    if (minQty !== undefined && (isNaN(minQty) || minQty < 0)) {
      throw new BadRequestError('Định mức tồn tối thiểu không hợp lệ.');
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
        minQuantity: minQty,
        price: prc,
        unit: unit !== undefined ? unit.trim() : undefined,
      },
    });

    await logActivity(userId, 'UPDATE_INVENTORY_PRODUCT', `Cập nhật sản phẩm kho: ${product.name} -> ${updatedProduct.name}`);
    notifyInventoryUpdate(userId, 'UPDATE_INVENTORY_PRODUCT', { productId: id });

    res.status(200).json({
      success: true,
      data: updatedProduct,
    });
  } catch (error) {
    next(error);
  }
};

// 4. Thao tác biến động kho (Nhập hàng / Xuất kho / Điều chỉnh kiểm kê)
const adjustInventoryStock = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.effectiveUserId;
    const { type, quantity, price, reason } = req.body;

    // type phải là 'IN' (Nhập), 'OUT' (Xuất) hoặc 'ADJUST' (Kiểm kê)
    if (!['IN', 'OUT', 'ADJUST'].includes(type)) {
      throw new BadRequestError('Loại thao tác kho không hợp lệ (chỉ chấp nhận IN, OUT, ADJUST).');
    }

    const inputQty = parseFloat(quantity);
    if (isNaN(inputQty) || inputQty < 0) {
      throw new BadRequestError('Số lượng thao tác không hợp lệ.');
    }

    if ((type === 'IN' || type === 'OUT') && inputQty <= 0) {
      throw new BadRequestError('Số lượng nhập hoặc xuất phải lớn hơn 0.');
    }

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

    const currentQty = parseFloat(product.quantity || 0);
    let newQty = currentQty;
    let deltaQty = inputQty;
    let inputPrice = price !== undefined && price !== null ? parseFloat(price) : parseFloat(product.price || 0);
    if (isNaN(inputPrice) || inputPrice < 0) {
      inputPrice = parseFloat(product.price || 0);
    }

    let defaultReason = '';
    if (type === 'IN') {
      newQty = currentQty + inputQty;
      deltaQty = inputQty;
      defaultReason = 'Nhập thêm hàng';
    } else if (type === 'OUT') {
      if (currentQty < inputQty) {
        throw new BadRequestError(`Số lượng tồn trong kho không đủ để xuất (Tồn hiện tại: ${currentQty} ${product.unit}, cần xuất: ${inputQty} ${product.unit}).`);
      }
      newQty = currentQty - inputQty;
      deltaQty = inputQty;
      defaultReason = 'Xuất kho';
    } else if (type === 'ADJUST') {
      newQty = inputQty;
      deltaQty = Math.abs(newQty - currentQty);
      defaultReason = newQty >= currentQty ? 'Điều chỉnh tăng (Kiểm kê)' : 'Điều chỉnh giảm (Hao hụt kiểm kê)';
    }

    const finalReason = reason && reason.trim() ? reason.trim() : defaultReason;

    // Thực thi trong Transaction đảm bảo tính toàn vẹn
    const result = await prisma.$transaction(async (tx) => {
      // 1. Cập nhật tồn kho sản phẩm (nếu nhập hàng có đơn giá mới thì cập nhật giá)
      const updateData = {
        quantity: newQty,
      };
      if (type === 'IN' && price !== undefined && parseFloat(price) > 0) {
        updateData.price = parseFloat(price);
      }

      const updatedProduct = await tx.inventoryProduct.update({
        where: { id },
        data: updateData,
      });

      // 2. Tạo bản ghi nhật ký biến động kho (InventoryLog)
      const log = await tx.inventoryLog.create({
        data: {
          userId,
          productId: id,
          createdBy: req.user.id,
          type,
          quantity: deltaQty,
          price: inputPrice,
          previousQty: currentQty,
          newQty,
          reason: finalReason,
        },
      });

      return { updatedProduct, log };
    });

    const actionText = type === 'IN' ? `Nhập +${deltaQty}` : type === 'OUT' ? `Xuất -${deltaQty}` : `Kiểm kê (${currentQty} -> ${newQty})`;
    await logActivity(userId, 'ADJUST_INVENTORY_STOCK', `${actionText} ${product.name} (${product.unit}). Lý do: ${finalReason}`);
    notifyInventoryUpdate(userId, 'ADJUST_INVENTORY_STOCK', { productId: id });

    res.status(200).json({
      success: true,
      message: 'Cập nhật kho thành công.',
      data: {
        product: result.updatedProduct,
        log: result.log,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 5. Lấy lịch sử biến động kho của 1 sản phẩm
const getInventoryLogs = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.effectiveUserId;

    // Kiểm tra sản phẩm có thuộc workspace này không
    const product = await prisma.inventoryProduct.findFirst({
      where: {
        id,
        userId,
      },
    });

    if (!product) {
      throw new NotFoundError('Sản phẩm kho không tồn tại.');
    }

    const logs = await prisma.inventoryLog.findMany({
      where: {
        productId: id,
        userId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 50, // Lấy 50 biến động gần nhất
    });

    res.status(200).json({
      success: true,
      data: {
        productName: product.name,
        unit: product.unit,
        currentQty: parseFloat(product.quantity || 0),
        logs,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 6. Xóa sản phẩm khỏi kho (Xóa mềm)
const deleteInventoryProduct = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.effectiveUserId;

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

    // Kiểm tra bảo vệ dữ liệu chéo: Nhân viên chỉ được xóa dữ liệu do chính mình tạo. Chủ Workspace và Admin tối cao có toàn quyền.
    const actorId = req.user.id;
    const actorIsAdmin = req.user.isAdmin === true;
    if (!actorIsAdmin && product.createdBy !== actorId && actorId !== product.userId) {
      throw new ForbiddenError('Tài khoản của bạn không có quyền xóa dữ liệu do người khác tạo.');
    }

    await prisma.inventoryProduct.update({
      where: { id },
      data: { isActive: false },
    });

    await logActivity(userId, 'DELETE_INVENTORY_PRODUCT', `Xóa sản phẩm khỏi kho: ${product.name}`);
    notifyInventoryUpdate(userId, 'DELETE_INVENTORY_PRODUCT', { productId: id });

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
  adjustInventoryStock,
  getInventoryLogs,
  deleteInventoryProduct,
};

