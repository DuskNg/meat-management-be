// meat-management-be/src/controllers/shop.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');
const { emitWorkspaceEvent } = require('../utils/socket');

// Helper gửi socket event thông báo bàn cửa hàng thay đổi
const notifyShopUpdate = (userId, action, payload = {}) => {
  emitWorkspaceEvent(userId, 'SHOP_TABLE_UPDATED', {
    action,
    userId,
    timestamp: new Date().toISOString(),
    ...payload,
  });
};

// 1. Lấy danh sách bàn kèm phiên chơi đang chạy (nếu có)
const getTables = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;

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
          include: {
            items: {
              include: {
                product: true,
              },
              orderBy: {
                createdAt: 'asc',
              },
            },
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
    const userId = req.effectiveUserId;
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
              createdBy: req.user.id,
            },
          })
        )
      );

      await logActivity(userId, 'CREATE_SHOP_TABLES_BULK', `Tạo hàng loạt ${createdTables.length} bàn cửa hàng`);
      notifyShopUpdate(userId, 'CREATE_TABLE_BULK');

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
        createdBy: req.user.id,
      },
    });

    await logActivity(userId, 'CREATE_SHOP_TABLE', `Tạo bàn cửa hàng mới: ${table.name} với giá ${price}đ/giờ`);
    notifyShopUpdate(userId, 'CREATE_TABLE', { tableId: table.id });

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
    const userId = req.effectiveUserId;
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
    notifyShopUpdate(userId, 'UPDATE_TABLE', { tableId: id });

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
    const userId = req.effectiveUserId;

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
    notifyShopUpdate(userId, 'DELETE_TABLE', { tableId: id });

    res.status(200).json({
      success: true,
      message: 'Xóa bàn thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 5. Bắt đầu phiên chơi mới (Bấm bắt đầu, hỗ trợ gọi kèm món/nước)
const startSession = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { tableId, items } = req.body;

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
        userId,
        isPaid: false,
      },
    });

    if (existingSession) {
      throw new BadRequestError('Bàn này đang được sử dụng hoặc chưa thanh toán phiên trước.');
    }

    // Kiểm tra tính hợp lệ và tồn kho của danh sách món chọn ban đầu (nếu có)
    const processedItems = [];
    if (items && Array.isArray(items) && items.length > 0) {
      for (const it of items) {
        const qty = parseFloat(it.quantity);
        if (isNaN(qty) || qty <= 0) {
          throw new BadRequestError('Số lượng món không hợp lệ.');
        }

        const product = await prisma.inventoryProduct.findFirst({
          where: {
            id: it.productId,
            userId,
            isActive: true,
          },
        });

        if (!product) {
          throw new NotFoundError(`Sản phẩm không tồn tại trong kho.`);
        }

        const currentStock = parseFloat(product.quantity || 0);
        if (currentStock < qty) {
          throw new BadRequestError(
            `Sản phẩm "${product.name}" trong kho không đủ (Kho hiện có: ${currentStock} ${product.unit}, yêu cầu: ${qty} ${product.unit}).`
          );
        }

        const itemPrice = it.price !== undefined && parseFloat(it.price) >= 0 ? parseFloat(it.price) : parseFloat(product.price || 0);
        processedItems.push({
          product,
          quantity: qty,
          price: itemPrice,
          currentStock,
        });
      }
    }

    // Tạo phiên chơi và trừ kho trong transaction
    const newSession = await prisma.$transaction(async (tx) => {
      // 1. Tạo session
      const session = await tx.shopSession.create({
        data: {
          tableId,
          userId,
          startTime: new Date(),
          createdBy: req.user.id,
        },
      });

      let extraAmount = 0;

      // 2. Thêm các món kèm theo (nếu có)
      for (const itemData of processedItems) {
        const { product, quantity: qty, price: itemPrice, currentStock } = itemData;

        // Trừ tồn kho
        await tx.inventoryProduct.update({
          where: { id: product.id },
          data: {
            quantity: {
              decrement: qty,
            },
          },
        });

        // Ghi nhật ký xuất kho
        await tx.inventoryLog.create({
          data: {
            userId,
            productId: product.id,
            createdBy: req.user.id,
            type: 'OUT',
            quantity: qty,
            price: itemPrice,
            previousQty: currentStock,
            newQty: currentStock - qty,
            reason: `Phục vụ khi mở bàn ${table.name}`,
          },
        });

        // Tạo bản ghi món trong phiên
        const itemAmount = Math.round(qty * itemPrice);
        extraAmount += itemAmount;

        await tx.shopSessionItem.create({
          data: {
            sessionId: session.id,
            productId: product.id,
            quantity: qty,
            price: itemPrice,
            amount: itemAmount,
          },
        });
      }

      if (extraAmount > 0) {
        return await tx.shopSession.update({
          where: { id: session.id },
          data: {
            extraAmount,
            totalAmount: extraAmount,
          },
          include: {
            table: true,
            items: {
              include: { product: true },
            },
          },
        });
      }

      return session;
    });

    const logDetails = processedItems.length > 0
      ? `Bắt đầu chơi tại bàn ${table.name} kèm ${processedItems.length} món`
      : `Bắt đầu chơi tại bàn ${table.name}`;
    await logActivity(userId, 'START_SHOP_SESSION', logDetails);
    notifyShopUpdate(userId, 'START_SESSION', { tableId, sessionId: newSession.id });
    if (processedItems.length > 0) {
      emitWorkspaceEvent(userId, 'INVENTORY_UPDATED', { action: 'DEDUCT_INVENTORY_FROM_SHOP', sessionId: newSession.id });
    }

    res.status(201).json({
      success: true,
      data: newSession,
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
  return totalPlayAmount + (session.extraAmount || 0);
};

// 6. Kết thúc phiên chơi (Bấm kết thúc) -> tính thời gian và tiền giờ
const endSession = async (req, res, next) => {
  try {
    const { id } = req.params; // Session ID
    const userId = req.effectiveUserId;

    const session = await prisma.shopSession.findFirst({
      where: {
        id,
        userId,
        isPaid: false,
      },
      include: {
        table: true,
        items: {
          include: { product: true },
        },
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
        items: {
          include: { product: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    await logActivity(
      userId,
      'END_SHOP_SESSION',
      `Kết thúc phiên chơi tại bàn ${session.table.name}. Tổng tiền tạm tính: ${totalAmount}đ`
    );
    notifyShopUpdate(userId, 'END_SESSION', { tableId: session.tableId, sessionId: id });

    res.status(200).json({
      success: true,
      data: updatedSession,
    });
  } catch (error) {
    next(error);
  }
};

// 7. Thêm khoản phụ thu thủ công (nếu có)
const addExtra = async (req, res, next) => {
  try {
    const { id } = req.params; // Session ID
    const userId = req.effectiveUserId;
    const { extraAmount, extraNote } = req.body;

    const session = await prisma.shopSession.findFirst({
      where: {
        id,
        userId,
        isPaid: false,
      },
      include: {
        table: true,
        items: {
          include: { product: true },
        },
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
        items: {
          include: { product: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    await logActivity(
      userId,
      'ADD_SHOP_EXTRA',
      `Cập nhật phụ thu ${amount}đ (${extraNote || 'Không có ghi chú'}) cho bàn ${session.table.name}`
    );
    notifyShopUpdate(userId, 'ADD_EXTRA', { tableId: session.tableId, sessionId: id });

    res.status(200).json({
      success: true,
      data: updatedSession,
    });
  } catch (error) {
    next(error);
  }
};

// 8. Thêm món từ Kho vào phiên chơi (TỰ ĐỘNG TRỪ TỒN KHO) - Hỗ trợ cả 1 món hoặc nhiều món cùng lúc
const addSessionItem = async (req, res, next) => {
  try {
    const { id } = req.params; // Session ID
    const userId = req.effectiveUserId;

    // Hỗ trợ cả 2 format: body chứa { items: [...] } hoặc { productId, quantity, price }
    let rawItems = [];
    if (Array.isArray(req.body.items)) {
      rawItems = req.body.items;
    } else if (req.body.productId) {
      rawItems = [
        {
          productId: req.body.productId,
          quantity: req.body.quantity,
          price: req.body.price,
        },
      ];
    }

    if (rawItems.length === 0) {
      throw new BadRequestError('Vui lòng chọn ít nhất 1 sản phẩm từ kho.');
    }

    const session = await prisma.shopSession.findFirst({
      where: {
        id,
        userId,
        isPaid: false,
      },
      include: {
        table: true,
        items: true,
      },
    });

    if (!session) {
      throw new NotFoundError('Phiên chơi không tồn tại hoặc đã thanh toán.');
    }

    // Xác thực tồn kho cho từng sản phẩm
    const processedItems = [];
    for (const it of rawItems) {
      const qty = parseFloat(it.quantity);
      if (isNaN(qty) || qty <= 0) {
        throw new BadRequestError('Số lượng gọi món phải lớn hơn 0.');
      }

      const product = await prisma.inventoryProduct.findFirst({
        where: {
          id: it.productId,
          userId,
          isActive: true,
        },
      });

      if (!product) {
        throw new NotFoundError(`Sản phẩm không tồn tại trong kho.`);
      }

      const currentStock = parseFloat(product.quantity || 0);
      if (currentStock < qty) {
        throw new BadRequestError(
          `Sản phẩm "${product.name}" trong kho không đủ (Kho hiện có: ${currentStock} ${product.unit}, yêu cầu: ${qty} ${product.unit}).`
        );
      }

      const itemPrice = it.price !== undefined && parseFloat(it.price) >= 0 ? parseFloat(it.price) : parseFloat(product.price || 0);
      processedItems.push({
        product,
        quantity: qty,
        price: itemPrice,
        currentStock,
      });
    }

    // Thực hiện trong Transaction: Trừ kho + Ghi log xuất kho + Thêm món vào phiên
    const updatedSession = await prisma.$transaction(async (tx) => {
      for (const itemData of processedItems) {
        const { product, quantity: qty, price: itemPrice, currentStock } = itemData;

        // 1. Trừ tồn kho
        await tx.inventoryProduct.update({
          where: { id: product.id },
          data: {
            quantity: {
              decrement: qty,
            },
          },
        });

        // 2. Ghi nhật ký xuất kho
        await tx.inventoryLog.create({
          data: {
            userId,
            productId: product.id,
            createdBy: req.user.id,
            type: 'OUT',
            quantity: qty,
            price: itemPrice,
            previousQty: currentStock,
            newQty: currentStock - qty,
            reason: `Phục vụ tại bàn/phòng ${session.table.name}`,
          },
        });

        // 3. Kiểm tra xem món này đã có trong phiên chơi chưa
        const existingItem = await tx.shopSessionItem.findFirst({
          where: {
            sessionId: id,
            productId: product.id,
          },
        });

        if (existingItem) {
          const nextQty = parseFloat(existingItem.quantity) + qty;
          const nextAmount = Math.round(nextQty * parseFloat(existingItem.price));
          await tx.shopSessionItem.update({
            where: { id: existingItem.id },
            data: {
              quantity: nextQty,
              amount: nextAmount,
            },
          });
        } else {
          const itemAmount = Math.round(qty * itemPrice);
          await tx.shopSessionItem.create({
            data: {
              sessionId: id,
              productId: product.id,
              quantity: qty,
              price: itemPrice,
              amount: itemAmount,
            },
          });
        }
      }

      // 4. Tính lại tổng tiền phụ thu của phiên chơi
      const allItems = await tx.shopSessionItem.findMany({
        where: { sessionId: id },
      });
      const newExtraAmount = allItems.reduce((sum, it) => sum + Math.round(parseFloat(it.amount || 0)), 0);

      const endTimeToUse = session.endTime || new Date();
      const playTimeMs = Math.max(0, new Date(endTimeToUse) - new Date(session.startTime));
      const playTimeHours = playTimeMs / (1000 * 60 * 60);
      const totalPlayAmount = Math.round(playTimeHours * session.table.pricePerHour);
      const newTotalAmount = totalPlayAmount + newExtraAmount;

      return await tx.shopSession.update({
        where: { id },
        data: {
          extraAmount: newExtraAmount,
          totalAmount: newTotalAmount,
        },
        include: {
          table: true,
          items: {
            include: { product: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
    });

    const summaryText = processedItems.map((p) => `${p.quantity} ${p.product.unit} ${p.product.name}`).join(', ');
    await logActivity(
      userId,
      'ADD_SHOP_SESSION_ITEM',
      `Thêm món (${summaryText}) cho bàn ${session.table.name} (Tự động trừ kho)`
    );
    notifyShopUpdate(userId, 'ADD_SESSION_ITEM', { tableId: session.tableId, sessionId: id });
    emitWorkspaceEvent(userId, 'INVENTORY_UPDATED', { action: 'DEDUCT_INVENTORY_FROM_SHOP', sessionId: id });

    res.status(200).json({
      success: true,
      message: `Đã thêm món (${summaryText}) và trừ kho thành công.`,
      data: updatedSession,
    });
  } catch (error) {
    next(error);
  }
};

// 9. Cập nhật số lượng món của phiên chơi (TĂNG ➔ TRỪ THÊM KHO, GIẢM ➔ HOÀN TRẢ KHO)
const updateSessionItemQuantity = async (req, res, next) => {
  try {
    const { id, itemId } = req.params; // Session ID & Item ID
    const userId = req.effectiveUserId;
    const { quantity } = req.body;

    const newQty = parseFloat(quantity);
    if (isNaN(newQty) || newQty < 0) {
      throw new BadRequestError('Số lượng không hợp lệ.');
    }

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
      throw new NotFoundError('Phiên chơi không tồn tại hoặc đã thanh toán.');
    }

    const item = await prisma.shopSessionItem.findFirst({
      where: {
        id: itemId,
        sessionId: id,
      },
      include: {
        product: true,
      },
    });

    if (!item) {
      throw new NotFoundError('Món phụ thu không tồn tại trong phiên chơi.');
    }

    const oldQty = parseFloat(item.quantity);
    const delta = newQty - oldQty;

    // Nếu số lượng không đổi
    if (delta === 0) {
      return res.status(200).json({ success: true, data: session });
    }

    // Nếu newQty === 0 ➔ Xóa món và hoàn trả toàn bộ
    if (newQty === 0) {
      return await removeSessionItemInternal(req, res, next, session, item);
    }

    const currentStock = parseFloat(item.product.quantity || 0);

    // Nếu tăng số lượng ➔ kiểm tra kho có đủ không
    if (delta > 0 && currentStock < delta) {
      throw new BadRequestError(
        `Kho không đủ hàng để tăng thêm (Kho hiện có: ${currentStock} ${item.product.unit}, cần thêm: ${delta} ${item.product.unit}).`
      );
    }

    const updatedSession = await prisma.$transaction(async (tx) => {
      // 1. Cập nhật kho
      if (delta > 0) {
        // Trừ thêm kho
        await tx.inventoryProduct.update({
          where: { id: item.productId },
          data: { quantity: { decrement: delta } },
        });
        await tx.inventoryLog.create({
          data: {
            userId,
            productId: item.productId,
            createdBy: req.user.id,
            type: 'OUT',
            quantity: delta,
            price: parseFloat(item.price),
            previousQty: currentStock,
            newQty: currentStock - delta,
            reason: `Tăng số lượng tại bàn/phòng ${session.table.name}`,
          },
        });
      } else {
        // Hoàn trả lại kho
        const returnQty = Math.abs(delta);
        await tx.inventoryProduct.update({
          where: { id: item.productId },
          data: { quantity: { increment: returnQty } },
        });
        await tx.inventoryLog.create({
          data: {
            userId,
            productId: item.productId,
            createdBy: req.user.id,
            type: 'IN',
            quantity: returnQty,
            price: parseFloat(item.price),
            previousQty: currentStock,
            newQty: currentStock + returnQty,
            reason: `Bớt món tại bàn/phòng ${session.table.name}`,
          },
        });
      }

      // 2. Cập nhật ShopSessionItem
      const itemAmount = Math.round(newQty * parseFloat(item.price));
      await tx.shopSessionItem.update({
        where: { id: itemId },
        data: {
          quantity: newQty,
          amount: itemAmount,
        },
      });

      // 3. Tính lại tổng tiền phụ thu và tổng hóa đơn
      const allItems = await tx.shopSessionItem.findMany({
        where: { sessionId: id },
      });
      const newExtraAmount = allItems.reduce((sum, it) => sum + Math.round(parseFloat(it.amount || 0)), 0);

      const endTimeToUse = session.endTime || new Date();
      const playTimeMs = Math.max(0, new Date(endTimeToUse) - new Date(session.startTime));
      const playTimeHours = playTimeMs / (1000 * 60 * 60);
      const totalPlayAmount = Math.round(playTimeHours * session.table.pricePerHour);
      const newTotalAmount = totalPlayAmount + newExtraAmount;

      return await tx.shopSession.update({
        where: { id },
        data: {
          extraAmount: newExtraAmount,
          totalAmount: newTotalAmount,
        },
        include: {
          table: true,
          items: {
            include: { product: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
    });

    notifyShopUpdate(userId, 'UPDATE_SESSION_ITEM', { tableId: session.tableId, sessionId: id });

    res.status(200).json({
      success: true,
      data: updatedSession,
    });
  } catch (error) {
    next(error);
  }
};

// Helper xóa món và hoàn trả kho
const removeSessionItemInternal = async (req, res, next, session, item) => {
  const userId = req.effectiveUserId;
  const returnQty = parseFloat(item.quantity);
  const currentStock = parseFloat(item.product.quantity || 0);

  const updatedSession = await prisma.$transaction(async (tx) => {
    // 1. Hoàn trả số lượng vào kho
    await tx.inventoryProduct.update({
      where: { id: item.productId },
      data: { quantity: { increment: returnQty } },
    });

    // 2. Ghi nhật ký nhập lại kho
    await tx.inventoryLog.create({
      data: {
        userId,
        productId: item.productId,
        createdBy: req.user.id,
        type: 'IN',
        quantity: returnQty,
        price: parseFloat(item.price),
        previousQty: currentStock,
        newQty: currentStock + returnQty,
        reason: `Hủy món khỏi bàn/phòng ${session.table.name}`,
      },
    });

    // 3. Xóa ShopSessionItem
    await tx.shopSessionItem.delete({
      where: { id: item.id },
    });

    // 4. Tính lại tổng tiền phụ thu
    const allItems = await tx.shopSessionItem.findMany({
      where: { sessionId: session.id },
    });
    const newExtraAmount = allItems.reduce((sum, it) => sum + Math.round(parseFloat(it.amount || 0)), 0);

    const endTimeToUse = session.endTime || new Date();
    const playTimeMs = Math.max(0, new Date(endTimeToUse) - new Date(session.startTime));
    const playTimeHours = playTimeMs / (1000 * 60 * 60);
    const totalPlayAmount = Math.round(playTimeHours * session.table.pricePerHour);
    const newTotalAmount = totalPlayAmount + newExtraAmount;

    return await tx.shopSession.update({
      where: { id: session.id },
      data: {
        extraAmount: newExtraAmount,
        totalAmount: newTotalAmount,
      },
      include: {
        table: true,
        items: {
          include: { product: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  });

  await logActivity(
    userId,
    'REMOVE_SHOP_SESSION_ITEM',
    `Hủy món ${item.product.name} (SL: ${returnQty}) khỏi bàn ${session.table.name} (Tự động hoàn kho)`
  );
  notifyShopUpdate(userId, 'REMOVE_SESSION_ITEM', { tableId: session.tableId, sessionId: session.id });

  return res.status(200).json({
    success: true,
    message: `Đã hủy món và hoàn trả ${returnQty} ${item.product.unit} vào kho.`,
    data: updatedSession,
  });
};

// 10. Xóa món khỏi phiên chơi (TỰ ĐỘNG HOÀN TRẢ LẠI KHO)
const removeSessionItem = async (req, res, next) => {
  try {
    const { id, itemId } = req.params; // Session ID & Item ID
    const userId = req.effectiveUserId;

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
      throw new NotFoundError('Phiên chơi không tồn tại hoặc đã thanh toán.');
    }

    const item = await prisma.shopSessionItem.findFirst({
      where: {
        id: itemId,
        sessionId: id,
      },
      include: {
        product: true,
      },
    });

    if (!item) {
      throw new NotFoundError('Món phụ thu không tồn tại trong phiên chơi.');
    }

    await removeSessionItemInternal(req, res, next, session, item);
  } catch (error) {
    next(error);
  }
};

// 11. Xác nhận thanh toán phiên chơi
const paySession = async (req, res, next) => {
  try {
    const { id } = req.params; // Session ID
    const userId = req.effectiveUserId;

    const session = await prisma.shopSession.findFirst({
      where: {
        id,
        userId,
        isPaid: false,
      },
      include: {
        table: true,
        items: {
          include: { product: true },
        },
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
        items: {
          include: { product: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    await logActivity(
      userId,
      'PAY_SHOP_SESSION',
      `Thanh toán thành công phiên chơi tại bàn ${session.table.name}. Số tiền: ${totalAmount}đ`
    );
    notifyShopUpdate(userId, 'PAY_SESSION', { tableId: session.tableId, sessionId: id });

    res.status(200).json({
      success: true,
      data: updatedSession,
    });
  } catch (error) {
    next(error);
  }
};

// 12. Lấy tổng doanh thu của phân hệ cửa hàng
const getTotalRevenue = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;

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

// 13. Lấy doanh thu theo ngày của cửa hàng
const getDailyRevenue = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;

    const sessions = await prisma.shopSession.findMany({
      where: {
        userId,
        isPaid: true,
      },
      select: {
        paidAt: true,
        totalAmount: true,
        extraAmount: true,
        startTime: true,
        endTime: true,
        table: {
          select: { pricePerHour: true },
        },
      },
      orderBy: {
        paidAt: 'desc',
      },
    });

    const dailyMap = {};
    sessions.forEach((s) => {
      if (!s.paidAt) return;
      // Chuyển sang múi giờ GMT+7 (Việt Nam)
      const vnDate = new Date(new Date(s.paidAt).getTime() + 7 * 3600 * 1000);
      const dateKey = vnDate.toISOString().split('T')[0];
      
      if (!dailyMap[dateKey]) {
        dailyMap[dateKey] = {
          dateKey,
          amount: 0,
          playAmount: 0,
          itemAmount: 0,
          totalMinutes: 0,
          sessionCount: 0,
        };
      }

      const start = new Date(s.startTime);
      const end = s.endTime ? new Date(s.endTime) : new Date(s.paidAt);
      const diffMs = Math.max(0, end - start);
      const minutes = Math.floor(diffMs / (1000 * 60));

      dailyMap[dateKey].amount += s.totalAmount;
      dailyMap[dateKey].itemAmount += (s.extraAmount || 0);
      dailyMap[dateKey].playAmount += (s.totalAmount - (s.extraAmount || 0));
      dailyMap[dateKey].totalMinutes += minutes;
      dailyMap[dateKey].sessionCount += 1;
    });

    const data = Object.values(dailyMap)
      .map((item) => ({
        ...item,
        totalHours: Number((item.totalMinutes / 60).toFixed(1)),
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

// Hàm tính toán khoảng thời gian bắt đầu và kết thúc ngày theo múi giờ Việt Nam GMT+7
const getVietnamDateRange = (dateStr) => {
  if (dateStr && dateStr.trim()) {
    const [year, month, day] = dateStr.trim().split('-').map(Number);
    const startUtc = new Date(Date.UTC(year, month - 1, day, -7, 0, 0, 0));
    const endUtc = new Date(Date.UTC(year, month - 1, day + 1, -7, 0, 0, -1));
    return { startUtc, endUtc, dateStr: dateStr.trim() };
  } else {
    const now = new Date();
    const vnTime = new Date(now.getTime() + 7 * 3600 * 1000);
    const year = vnTime.getUTCFullYear();
    const month = vnTime.getUTCMonth();
    const day = vnTime.getUTCDate();
    const startUtc = new Date(Date.UTC(year, month, day, -7, 0, 0, 0));
    const endUtc = new Date(Date.UTC(year, month, day + 1, -7, 0, 0, -1));
    const formattedDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { startUtc, endUtc, dateStr: formattedDate };
  }
};

// 14. Lấy chi tiết lịch sử phiên chơi (theo ngày hoặc theo bàn cụ thể trong ngày)
const getSessionsHistory = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { tableId, date } = req.query;

    const { startUtc, endUtc, dateStr } = getVietnamDateRange(date);

    const whereClause = {
      userId,
      startTime: {
        gte: startUtc,
        lte: endUtc,
      },
    };

    if (tableId) {
      whereClause.tableId = tableId;
    }

    const sessions = await prisma.shopSession.findMany({
      where: whereClause,
      include: {
        table: true,
        items: {
          include: { product: true },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: {
        startTime: 'asc',
      },
    });

    let totalRevenue = 0;
    let totalPlayAmount = 0;
    let totalItemAmount = 0;
    let totalPlayMinutes = 0;

    const formattedSessions = sessions.map((s) => {
      const start = new Date(s.startTime);
      const end = s.endTime ? new Date(s.endTime) : (s.paidAt ? new Date(s.paidAt) : new Date());
      const diffMs = Math.max(0, end - start);
      const totalMinutes = Math.floor(diffMs / (1000 * 60));
      const hours = diffMs / (1000 * 60 * 60);
      const playAmount = Math.round(hours * (s.table?.pricePerHour || 0));
      const extraAmount = s.extraAmount || 0;
      const total = s.isPaid ? s.totalAmount : playAmount + extraAmount;

      if (s.isPaid) {
        totalRevenue += total;
        totalPlayAmount += Math.max(0, total - extraAmount);
        totalItemAmount += extraAmount;
      }
      totalPlayMinutes += totalMinutes;

      const hr = Math.floor(totalMinutes / 60);
      const mn = totalMinutes % 60;
      const durationStr = hr > 0 ? `${hr}h ${mn}p` : `${mn}p`;

      return {
        ...s,
        calculatedPlayAmount: playAmount,
        calculatedTotalAmount: total,
        durationMinutes: totalMinutes,
        durationHours: Number(hours.toFixed(2)),
        durationStr,
      };
    });

    const totalHours = Number((totalPlayMinutes / 60).toFixed(1));

    res.status(200).json({
      success: true,
      data: {
        date: dateStr,
        sessions: formattedSessions,
        stats: {
          totalRevenue,
          totalPlayAmount,
          totalItemAmount,
          totalHours,
          totalSessions: sessions.length,
          paidSessions: sessions.filter((s) => s.isPaid).length,
        },
      },
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
  addSessionItem,
  updateSessionItemQuantity,
  removeSessionItem,
  paySession,
  getTotalRevenue,
  getDailyRevenue,
  getSessionsHistory,
};

