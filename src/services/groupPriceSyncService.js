// meat-management-be/src/services/groupPriceSyncService.js
const prisma = require('../utils/db');
const { logActivity } = require('../utils/activityLogger');

/**
 * Dịch vụ đồng bộ bộ giá riêng của nhóm cho các nhà hàng mới được thêm vào nhóm.
 * 
 * Nghiệp vụ:
 * Khi có một hoặc nhiều nhà hàng mới được thêm vào một nhóm (ví dụ: nhóm chuỗi nhà hàng),
 * hệ thống sẽ tự động quét bộ giá riêng hiện tại của các thành viên đang có trong nhóm (nhà hàng nguồn),
 * xác định mức giá riêng đại diện của nhóm cho từng loại thịt (ưu tiên mức giá phổ biến nhất - majority price),
 * và tự động thiết lập bộ giá riêng này vào bảng CustomerProductPrice cho các nhà hàng mới.
 * 
 * @param {Object} params
 * @param {string} params.userId - ID chủ buôn sở hữu dữ liệu
 * @param {string} [params.groupName] - Tên nhóm nhà hàng (để ghi lý do đổi giá và lịch sử)
 * @param {string[]} params.sourceCustomerIds - Danh sách ID các nhà hàng hiện có trong nhóm (nguồn giá)
 * @param {string[]} params.targetCustomerIds - Danh sách ID các nhà hàng mới được thêm vào nhóm (đích nhận giá)
 * @param {Object} [params.tx] - Prisma transaction client (nếu đang chạy trong transaction)
 * @returns {Promise<Object>} Kết quả đồng bộ
 */
const syncGroupCustomPricesToNewCustomers = async ({
  userId,
  groupName = 'Nhóm nhà hàng',
  sourceCustomerIds = [],
  targetCustomerIds = [],
  tx = null,
}) => {
  const db = tx || prisma;

  // 1. Kiểm tra danh sách đầu vào
  if (!Array.isArray(targetCustomerIds) || targetCustomerIds.length === 0) {
    return {
      success: true,
      syncedCustomerCount: 0,
      syncedProductCount: 0,
      message: 'Không có nhà hàng mới nào cần áp dụng giá nhóm.',
      groupPrices: [],
    };
  }

  if (!Array.isArray(sourceCustomerIds) || sourceCustomerIds.length === 0) {
    return {
      success: true,
      syncedCustomerCount: 0,
      syncedProductCount: 0,
      message: 'Nhóm chưa có nhà hàng thành viên cũ để lấy bộ giá riêng làm mẫu.',
      groupPrices: [],
    };
  }

  // Lọc bỏ các ID trùng nhau giữa nguồn và đích (chỉ áp dụng cho thành viên mới thực sự)
  const cleanTargetIds = Array.from(new Set(targetCustomerIds)).filter(
    (id) => !sourceCustomerIds.includes(id)
  );

  if (cleanTargetIds.length === 0) {
    return {
      success: true,
      syncedCustomerCount: 0,
      syncedProductCount: 0,
      message: 'Tất cả nhà hàng đã nằm trong danh sách thành viên hiện tại.',
      groupPrices: [],
    };
  }

  const cleanSourceIds = Array.from(new Set(sourceCustomerIds));

  // 2. Lấy toàn bộ giá riêng đang có của các nhà hàng nguồn cho các sản phẩm còn đang hoạt động
  const sourceCustomPrices = await db.customerProductPrice.findMany({
    where: {
      customerId: { in: cleanSourceIds },
      product: {
        userId,
        isActive: true,
      },
    },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          defaultPrice: true,
          costPrice: true,
          unit: true,
        },
      },
    },
    orderBy: {
      updatedAt: 'desc',
    },
  });

  if (sourceCustomPrices.length === 0) {
    return {
      success: true,
      syncedCustomerCount: 0,
      syncedProductCount: 0,
      message: 'Các nhà hàng hiện tại trong nhóm chưa có bộ giá riêng nào.',
      groupPrices: [],
    };
  }

  // 3. Gom nhóm giá theo từng productId để tìm mức giá đại diện của nhóm (Majority / Mode price)
  const productPriceGroups = new Map();

  for (const cp of sourceCustomPrices) {
    const pId = cp.productId;
    if (!productPriceGroups.has(pId)) {
      productPriceGroups.set(pId, {
        product: cp.product,
        entries: [],
      });
    }
    productPriceGroups.get(pId).entries.push({
      price: Number(cp.price),
      costPrice: cp.costPrice !== null && cp.costPrice !== undefined ? Number(cp.costPrice) : null,
      updatedAt: cp.updatedAt,
      customerId: cp.customerId,
    });
  }

  // Tính mức giá đại diện cho từng sản phẩm
  const groupPrices = [];

  for (const [productId, groupData] of productPriceGroups.entries()) {
    const { product, entries } = groupData;
    if (entries.length === 0) continue;

    // Đếm tần suất mức giá bán
    const frequencyMap = new Map();
    for (const entry of entries) {
      const priceKey = entry.price;
      if (!frequencyMap.has(priceKey)) {
        frequencyMap.set(priceKey, {
          price: entry.price,
          count: 0,
          latestUpdatedAt: entry.updatedAt,
          costPrices: [],
        });
      }
      const item = frequencyMap.get(priceKey);
      item.count += 1;
      if (entry.costPrice !== null) {
        item.costPrices.push(entry.costPrice);
      }
      if (new Date(entry.updatedAt) > new Date(item.latestUpdatedAt)) {
        item.latestUpdatedAt = entry.updatedAt;
      }
    }

    // Chọn mức giá có số lượng thành viên áp dụng nhiều nhất (nếu hòa, lấy mức cập nhật mới nhất)
    const sortedPrices = Array.from(frequencyMap.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return new Date(b.latestUpdatedAt) - new Date(a.latestUpdatedAt);
    });

    const bestPriceEntry = sortedPrices[0];
    const representativePrice = bestPriceEntry.price;

    // Giá vốn đại diện (nếu có)
    let representativeCostPrice = null;
    if (bestPriceEntry.costPrices.length > 0) {
      representativeCostPrice = bestPriceEntry.costPrices[0];
    } else if (entries.some((e) => e.costPrice !== null)) {
      representativeCostPrice = entries.find((e) => e.costPrice !== null).costPrice;
    }

    groupPrices.push({
      productId,
      productName: product.name,
      unit: product.unit,
      price: representativePrice,
      costPrice: representativeCostPrice,
      appliedMembersCount: bestPriceEntry.count,
      totalSourceMembersCount: cleanSourceIds.length,
    });
  }

  if (groupPrices.length === 0) {
    return {
      success: true,
      syncedCustomerCount: 0,
      syncedProductCount: 0,
      message: 'Không tìm thấy mức giá riêng hợp lệ từ các thành viên nhóm.',
      groupPrices: [],
    };
  }

  // 4. Thiết lập (upsert) bộ giá riêng này cho tất cả các nhà hàng mới được thêm vào nhóm
  const changeReason = `Thiết lập theo bộ giá riêng của nhóm [${groupName || 'Nhóm nhà hàng'}]`;
  let totalUpserted = 0;

  for (const targetId of cleanTargetIds) {
    for (const item of groupPrices) {
      await db.customerProductPrice.upsert({
        where: {
          customerId_productId: {
            customerId: targetId,
            productId: item.productId,
          },
        },
        update: {
          price: item.price,
          ...(item.costPrice !== null && item.costPrice !== undefined
            ? { costPrice: item.costPrice }
            : {}),
          changeReason,
          updatedAt: new Date(),
        },
        create: {
          customerId: targetId,
          productId: item.productId,
          price: item.price,
          costPrice: item.costPrice !== null ? item.costPrice : null,
          changeReason,
        },
      });
      totalUpserted++;
    }
  }

  return {
    success: true,
    syncedCustomerCount: cleanTargetIds.length,
    syncedProductCount: groupPrices.length,
    totalRecordsUpserted: totalUpserted,
    message: `Đã thiết lập bộ giá riêng của nhóm [${groupName}] (${groupPrices.length} loại thịt) cho ${cleanTargetIds.length} nhà hàng mới!`,
    groupPrices: groupPrices.map((p) => ({
      productId: p.productId,
      productName: p.productName,
      unit: p.unit,
      price: p.price,
      costPrice: p.costPrice,
    })),
  };
};

module.exports = {
  syncGroupCustomPricesToNewCustomers,
};
