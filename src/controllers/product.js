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

// 5. Lấy danh sách các loại thịt của từng khách hàng được cập nhật giá trong ngày
const getDailyPriceUpdates = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { date } = req.query; // date có thể là YYYY-MM-DD hoặc DD/MM/YYYY

    // Xác định ngày mục tiêu theo múi giờ Việt Nam (UTC+7)
    let targetDateStr = date;
    if (!targetDateStr) {
      const now = new Date();
      const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
      targetDateStr = vnNow.toISOString().split('T')[0];
    } else if (targetDateStr.includes('/')) {
      const [d, m, y] = targetDateStr.split('/');
      targetDateStr = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }

    // Khoảng thời gian từ 00:00:00 đến 23:59:59.999 theo múi giờ GMT+7
    const [year, month, day] = targetDateStr.split('-').map(Number);
    const startOfDayUtc = new Date(Date.UTC(year, month - 1, day, -7, 0, 0, 0));
    const endOfDayUtc = new Date(Date.UTC(year, month - 1, day, 16, 59, 59, 999));

    // 1. Lấy tất cả giao dịch trong ngày của chủ buôn này
    const dayTransactions = await prisma.transaction.findMany({
      where: {
        userId,
        date: {
          gte: startOfDayUtc,
          lte: endOfDayUtc,
        },
      },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                unit: true,
                defaultPrice: true,
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    // 2. Lấy tất cả bản ghi CustomerProductPrice được cập nhật trong ngày
    const updatedCustomPrices = await prisma.customerProductPrice.findMany({
      where: {
        customer: {
          userId,
        },
        updatedAt: {
          gte: startOfDayUtc,
          lte: endOfDayUtc,
        },
      },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
        product: {
          select: {
            id: true,
            name: true,
            unit: true,
            defaultPrice: true,
          },
        },
      },
      orderBy: {
        updatedAt: 'asc',
      },
    });

    // 3. Tổng hợp danh sách theo từng khách hàng
    const customerMap = new Map();

    // Duyệt qua transactions trong ngày
    for (const trans of dayTransactions) {
      if (!trans.customer) continue;
      const cId = trans.customerId;
      if (!customerMap.has(cId)) {
        customerMap.set(cId, {
          customerId: cId,
          customerName: trans.customer.name,
          customerPhone: trans.customer.phone || '',
          lastUpdatedAt: trans.createdAt,
          productsMap: new Map(),
        });
      }

      const custEntry = customerMap.get(cId);
      if (new Date(trans.createdAt) > new Date(custEntry.lastUpdatedAt)) {
        custEntry.lastUpdatedAt = trans.createdAt;
      }

      for (const item of (trans.items || [])) {
        if (!item.product) continue;
        const pId = item.productId;
        const currentPrice = parseFloat(item.price);
        const quantity = parseFloat(item.quantity || 0);

        if (!custEntry.productsMap.has(pId)) {
          custEntry.productsMap.set(pId, {
            productId: pId,
            productName: item.product.name,
            unit: item.product.unit || 'kg',
            defaultPrice: parseFloat(item.product.defaultPrice || 0),
            price: currentPrice,
            totalQuantity: quantity,
            updatedAt: trans.createdAt,
            source: 'transaction',
          });
        } else {
          const prodEntry = custEntry.productsMap.get(pId);
          prodEntry.price = currentPrice;
          prodEntry.totalQuantity += quantity;
          if (new Date(trans.createdAt) > new Date(prodEntry.updatedAt)) {
            prodEntry.updatedAt = trans.createdAt;
          }
        }
      }
    }

    // Duyệt qua CustomerProductPrice được cập nhật trong ngày
    for (const cp of updatedCustomPrices) {
      if (!cp.customer || !cp.product) continue;
      const cId = cp.customerId;
      if (!customerMap.has(cId)) {
        customerMap.set(cId, {
          customerId: cId,
          customerName: cp.customer.name,
          customerPhone: cp.customer.phone || '',
          lastUpdatedAt: cp.updatedAt,
          productsMap: new Map(),
        });
      }

      const custEntry = customerMap.get(cId);
      if (new Date(cp.updatedAt) > new Date(custEntry.lastUpdatedAt)) {
        custEntry.lastUpdatedAt = cp.updatedAt;
      }

      const pId = cp.productId;
      const currentPrice = parseFloat(cp.price);

      if (!custEntry.productsMap.has(pId)) {
        custEntry.productsMap.set(pId, {
          productId: pId,
          productName: cp.product.name,
          unit: cp.product.unit || 'kg',
          defaultPrice: parseFloat(cp.product.defaultPrice || 0),
          price: currentPrice,
          totalQuantity: 0,
          updatedAt: cp.updatedAt,
          source: 'price_update',
        });
      } else {
        const prodEntry = custEntry.productsMap.get(pId);
        if (new Date(cp.updatedAt) >= new Date(prodEntry.updatedAt)) {
          prodEntry.price = currentPrice;
          prodEntry.updatedAt = cp.updatedAt;
        }
      }
    }

    // Chuyển Map thành Array
    const result = Array.from(customerMap.values()).map((cust) => ({
      customerId: cust.customerId,
      customerName: cust.customerName,
      customerPhone: cust.customerPhone,
      lastUpdatedAt: cust.lastUpdatedAt,
      products: Array.from(cust.productsMap.values()).sort((a, b) => a.productName.localeCompare(b.productName)),
    }));

    // Sắp xếp khách hàng theo thời gian cập nhật mới nhất lên đầu
    result.sort((a, b) => new Date(b.lastUpdatedAt) - new Date(a.lastUpdatedAt));

    // Thống kê tổng hợp
    let totalPriceUpdates = 0;
    const uniqueProducts = new Set();
    result.forEach((c) => {
      totalPriceUpdates += c.products.length;
      c.products.forEach((p) => uniqueProducts.add(p.productId));
    });

    res.status(200).json({
      success: true,
      data: {
        date: targetDateStr,
        totalCustomers: result.length,
        totalUpdates: totalPriceUpdates,
        uniqueProductsCount: uniqueProducts.size,
        customers: result,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 6. Cập nhật hoặc lưu mới đơn giá thịt riêng cho khách hàng
const updateCustomerProductPrice = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { customerId, productId, price } = req.body;

    if (!customerId || !productId || price === undefined) {
      throw new BadRequestError('customerId, productId và price là bắt buộc.');
    }

    const numericPrice = parseFloat(price);
    if (isNaN(numericPrice) || numericPrice < 0) {
      throw new BadRequestError('Đơn giá không hợp lệ.');
    }

    // Kiểm tra khách hàng và sản phẩm có thuộc chủ buôn này không
    const [customer, product] = await Promise.all([
      prisma.customer.findFirst({
        where: { id: customerId, userId, isActive: true },
      }),
      prisma.product.findFirst({
        where: { id: productId, userId, isActive: true },
      }),
    ]);

    if (!customer) {
      throw new NotFoundError('Không tìm thấy khách hàng.');
    }
    if (!product) {
      throw new NotFoundError('Không tìm thấy sản phẩm thịt.');
    }

    // Upsert CustomerProductPrice
    const updatedPrice = await prisma.customerProductPrice.upsert({
      where: {
        customerId_productId: {
          customerId,
          productId,
        },
      },
      update: {
        price: numericPrice,
      },
      create: {
        customerId,
        productId,
        price: numericPrice,
      },
    });

    // Ghi log hoạt động
    await logActivity(
      userId,
      'UPDATE_CUSTOMER_PRICE',
      `Cập nhật giá thịt: Khách hàng "${customer.name}" - Mặt hàng "${product.name}" = ${Number(numericPrice).toLocaleString('vi-VN')}đ/${product.unit}`
    );

    res.status(200).json({
      success: true,
      message: 'Đã cập nhật giá thịt cho khách hàng thành công.',
      data: updatedPrice,
    });
  } catch (error) {
    next(error);
  }
};

// 7. Cập nhật giá bán và giá nhập đồng loạt cho nhiều loại thịt
const batchUpdateProductPrices = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { items } = req.body; // Array: [{ id, defaultPrice, costPrice }]

    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestError('Danh sách sản phẩm cập nhật giá không được để trống.');
    }

    const updatedItems = [];
    const logDetails = [];

    // Thực hiện trong transaction để cập nhật nhanh và bảo đảm an toàn dữ liệu
    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        if (!item.id) continue;
        const defaultPrice = item.defaultPrice !== undefined ? parseFloat(item.defaultPrice) : undefined;
        const costPrice = item.costPrice !== undefined ? parseFloat(item.costPrice) : undefined;

        // Kiểm tra sản phẩm thuộc chủ buôn này
        const existing = await tx.product.findFirst({
          where: { id: item.id, userId, isActive: true },
        });
        if (!existing) continue;

        const updateData = {};
        if (defaultPrice !== undefined && !isNaN(defaultPrice) && defaultPrice >= 0) {
          updateData.defaultPrice = defaultPrice;
        }
        if (costPrice !== undefined && !isNaN(costPrice) && costPrice >= 0) {
          updateData.costPrice = costPrice;
        }

        if (Object.keys(updateData).length > 0) {
          const updated = await tx.product.update({
            where: { id: item.id },
            data: updateData,
          });
          updatedItems.push(updated);
          logDetails.push(
            `${existing.name}: Bán ${Number(existing.defaultPrice).toLocaleString('vi-VN')}đ -> ${Number(updated.defaultPrice).toLocaleString('vi-VN')}đ, Nhập ${Number(existing.costPrice).toLocaleString('vi-VN')}đ -> ${Number(updated.costPrice).toLocaleString('vi-VN')}đ`
          );
        }
      }
    });

    if (logDetails.length > 0) {
      await logActivity(
        userId,
        'BATCH_UPDATE_PRODUCT_PRICES',
        `Cập nhật giá đồng loạt cho ${logDetails.length} loại thịt: ${logDetails.slice(0, 5).join('; ')}${logDetails.length > 5 ? ` và ${logDetails.length - 5} loại khác` : ''}`
      );
    }

    res.status(200).json({
      success: true,
      message: `Đã cập nhật giá thành công cho ${updatedItems.length} loại thịt.`,
      data: updatedItems,
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
  getDailyPriceUpdates,
  updateCustomerProductPrice,
  batchUpdateProductPrices,
};
