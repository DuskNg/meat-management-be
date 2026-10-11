// meat-management-be/tests/xgBoQuantity.test.js
import { describe, it, expect } from 'vitest';

/**
 * Kiểm thử tự động cho logic xử lý số lượng món Xg Bò (Xương bò):
 * - Xương bò luôn bán số lượng lớn (>= 5kg) và luôn là số nguyên (5, 10, 12, 15, 17, 20...).
 * - Nét chữ viết tay số 17, 15, 12, 10 dễ bị AI đọc nhầm thành 1.7, 1.5, 1.2, 1.0 -> Auto chuẩn hóa thành 17, 15, 12, 10.
 * - Có đối chiếu với Thành tiền: ví dụ Thành tiền 425.000đ, Đơn giá 25.000đ -> số lượng chính xác là 17kg (425 / 25 = 17).
 * - Sườn xg (bán lẻ 1 - 1.5kg bình thường) tuyệt đối không bị ảnh hưởng.
 */

// Hàm mô phỏng logic chuẩn hóa số lượng Xg bò từ aiInvoiceParser.js
function resolveXgBoQuantity({ rawName, quantity, rawAmount, unitPrice }) {
  const cleanLower = rawName.toLowerCase().trim();
  const isSuonXg = cleanLower.includes('suon');
  const isXgBo = !isSuonXg && (
    cleanLower === 'xg bo' ||
    cleanLower === 'xg' ||
    cleanLower === 'x' ||
    cleanLower === 'xuong' ||
    cleanLower === 'xuong bo' ||
    (cleanLower.length === 1 && cleanLower !== 's')
  );

  let qty = quantity;

  if (isXgBo && qty != null) {
    // 1. Kiểm tra đối chiếu với Thành tiền nếu có
    let rawAmtForXg = rawAmount != null ? parseFloat(rawAmount) : null;
    if (rawAmtForXg != null && rawAmtForXg > 0 && rawAmtForXg < 10000) {
      rawAmtForXg = Math.round(rawAmtForXg * 1000); // 425 -> 425000
    }
    const effectiveUnitPrice = unitPrice != null ? parseFloat(unitPrice) : null;

    let resolvedByAmount = false;
    if (rawAmtForXg != null && rawAmtForXg > 0 && effectiveUnitPrice != null && effectiveUnitPrice > 0) {
      const calcQty = rawAmtForXg / effectiveUnitPrice;
      if (calcQty >= 5 && Math.abs(calcQty - Math.round(calcQty)) < 0.15) {
        qty = Math.round(calcQty);
        resolvedByAmount = true;
      }
    }

    if (!resolvedByAmount) {
      // 2. Nếu AI đọc nhầm các số hàng chục (10 - 49) thành số thập phân:
      if (qty < 5) {
        if (qty >= 1 && qty < 5) {
          qty = Math.round(qty * 10);
        }
      }
      if (qty != null) {
        qty = Math.round(qty);
      }
    }
  }

  return { isXgBo, quantity: qty };
}

describe('Kiểm thử tự động logic chuẩn hóa số lượng Xg Bò (Xương bò)', () => {
  it('1. Trường hợp hóa đơn có thành tiền 425k và đơn giá 25k: Phải ra đúng 17kg (không phải 1.7kg)', () => {
    const result = resolveXgBoQuantity({
      rawName: 'Xg',
      quantity: 1.7,
      rawAmount: 425, // 425k
      unitPrice: 25000,
    });

    expect(result.isXgBo).toBe(true);
    expect(result.quantity).toBe(17);
  });

  it('2. Trường hợp hóa đơn chỉ có số kg 1.7 (không rõ thành tiền): Phải tự động chuyển thành 17kg', () => {
    const result = resolveXgBoQuantity({
      rawName: 'xg bo',
      quantity: 1.7,
      rawAmount: null,
      unitPrice: 25000,
    });

    expect(result.isXgBo).toBe(true);
    expect(result.quantity).toBe(17);
  });

  it('3. Trường hợp số kg đọc là 1.5 hoặc 1.2 hoặc 1: Phải chuyển thành 15, 12, 10', () => {
    expect(resolveXgBoQuantity({ rawName: 'x', quantity: 1.5 }).quantity).toBe(15);
    expect(resolveXgBoQuantity({ rawName: 'xg', quantity: 1.2 }).quantity).toBe(12);
    expect(resolveXgBoQuantity({ rawName: 'xg bo', quantity: 1.0 }).quantity).toBe(10);
    expect(resolveXgBoQuantity({ rawName: 'x', quantity: 1 }).quantity).toBe(10);
  });

  it('4. Xương bò luôn là số nguyên: nếu đọc 17.2 -> chuyển thành 17', () => {
    const result = resolveXgBoQuantity({
      rawName: 'xg bo',
      quantity: 17.2,
      rawAmount: null,
      unitPrice: 25000,
    });

    expect(result.quantity).toBe(17);
  });

  it('5. Tuyệt đối không ảnh hưởng đến Sườn xg: Sườn xg 1.5kg giữ nguyên 1.5kg', () => {
    const result = resolveXgBoQuantity({
      rawName: 'Sườn xg',
      quantity: 1.5,
      rawAmount: 180000,
      unitPrice: 120000,
    });

    expect(result.isXgBo).toBe(false);
    expect(result.quantity).toBe(1.5);
  });
});
