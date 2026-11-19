// meat-management-be/src/utils/supplierPriceHelper.js
const prisma = require('./db');

/**
 * Lấy danh sách sản phẩm kèm giá nhập riêng theo nhà cung cấp.
 * Ưu tiên: 1) Bảng giá riêng SupplierProductPrice -> 2) Lịch sử giao dịch nhập hàng gần nhất -> 3) Giá nhập / giá chung của sản phẩm.
 */
async function getProductsWithSupplierPrices(userId, supplierId) {
  const [products, explicitPrices, supTxs] = await Promise.all([
    prisma.product.findMany({
      where: { userId, isActive: true },
      orderBy: { name: 'asc' },
    }),
    prisma.supplierProductPrice.findMany({
      where: { supplierId },
      select: { productId: true, price: true },
    }),
    prisma.supplierTransaction.findMany({
      where: { supplierId, items: { not: null } },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 100,
      select: { items: true },
    }),
  ]);

  // Bản đồ giá nhập cố định đã cấu hình cho nhà cung cấp
  const explicitPriceMap = new Map();
  for (const row of explicitPrices) {
    const val = Number(row.price);
    if (!Number.isNaN(val) && val > 0) {
      explicitPriceMap.set(row.productId, val);
    }
  }

  // Bản đồ giá nhập suy ra từ lịch sử giao dịch gần nhất
  const historyPriceMap = new Map();
  for (const stx of supTxs) {
    if (!stx.items) continue;
    try {
      const parsedItems = JSON.parse(stx.items);
      if (Array.isArray(parsedItems)) {
        for (const it of parsedItems) {
          const itPrice = it.price != null && !Number.isNaN(Number(it.price)) && Number(it.price) > 0
            ? Number(it.price)
            : null;
          if (itPrice !== null) {
            if (it.productId && !historyPriceMap.has(it.productId)) {
              historyPriceMap.set(it.productId, itPrice);
            }
            const nameKey = (it.productName || it.rawName || '').toLowerCase().trim();
            if (nameKey && !historyPriceMap.has(nameKey)) {
              historyPriceMap.set(nameKey, itPrice);
            }
          }
        }
      }
    } catch {
      // Bỏ qua nếu JSON items bị lỗi định dạng
    }
  }

  return products.map((p) => {
    const pNameKey = p.name.toLowerCase().trim();
    let supPrice = null;

    if (explicitPriceMap.has(p.id)) {
      supPrice = explicitPriceMap.get(p.id);
    } else if (historyPriceMap.has(p.id)) {
      supPrice = historyPriceMap.get(p.id);
    } else if (historyPriceMap.has(pNameKey)) {
      supPrice = historyPriceMap.get(pNameKey);
    }

    const hasCustomPrice = supPrice !== null && supPrice > 0;
    const effectivePrice = hasCustomPrice
      ? supPrice
      : (p.costPrice > 0 ? Number(p.costPrice) : Number(p.defaultPrice));

    return {
      ...p,
      baseDefaultPrice: p.defaultPrice,
      hasCustomPrice,
      customPrice: supPrice,
      defaultPrice: effectivePrice,
      costPrice: effectivePrice,
    };
  });
}

module.exports = {
  getProductsWithSupplierPrices,
};
