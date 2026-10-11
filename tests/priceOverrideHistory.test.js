// meat-management-be/tests/priceOverrideHistory.test.js
import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Kiểm thử tự động cho logic theo dõi vết đổi giá "Chỉ lần này":
 * - Lần 1: Khách A đổi giá món X sang 200k -> chọn "Chỉ lần này" -> count = 1. Chưa đủ 2 lần trước -> không gợi ý.
 * - Lần 2: Khách A đổi giá món X sang 200k -> chọn "Chỉ lần này" -> count = 2. Đã có 2 lần trước cùng giá.
 * - Lần 3: Khách A đổi giá món X sang 200k -> Khi chọn "Chỉ lần này", phát hiện streak (2 lần trước cùng giá 200k) -> Gợi ý bật popup!
 * - Nếu người dùng bấm "Cập nhật từ bây giờ" -> Xóa vết (clear) -> các lần sau bắt đầu lại từ đầu.
 * - Nếu người dùng đổi sang giá khác (ví dụ 210k) -> Chuỗi bị reset về 1 với giá mới, không kích hoạt cảnh báo sai.
 */

// Mô phỏng logic tương đương với src/utils/priceOverrideHistory.js
class PriceOverrideTracker {
  constructor() {
    this.storage = new Map();
  }

  makeKey(customerId, productId) {
    return `meat_price_override_history_${customerId || 'all'}_${productId}`;
  }

  checkStreakBeforeOneTime(customerId, changedItems = []) {
    if (!customerId || !Array.isArray(changedItems) || changedItems.length === 0) {
      return [];
    }

    const streakItems = [];
    for (const item of changedItems) {
      const prodId = item.productId || item.id;
      const newPrice = Number(item.newPrice);
      if (!prodId || isNaN(newPrice)) continue;

      const key = this.makeKey(customerId, prodId);
      const history = this.storage.get(key);

      // Nếu trước đó đã ghi nhận lịch sử cùng một mức giá và số lần liên tiếp >= 2
      if (history && Number(history.price) === newPrice && Number(history.count) >= 2) {
        streakItems.push({
          productId: prodId,
          productName: item.productName || item.name || 'Mặt hàng',
          price: newPrice,
          count: Number(history.count),
        });
      }
    }
    return streakItems;
  }

  recordOneTimeOverride(customerId, changedItems = []) {
    if (!customerId || !Array.isArray(changedItems) || changedItems.length === 0) {
      return;
    }

    for (const item of changedItems) {
      const prodId = item.productId || item.id;
      const newPrice = Number(item.newPrice);
      if (!prodId || isNaN(newPrice)) continue;

      const key = this.makeKey(customerId, prodId);
      const prev = this.storage.get(key);

      let nextCount = 1;
      if (prev && Number(prev.price) === newPrice) {
        nextCount = (Number(prev.count) || 1) + 1;
      }

      this.storage.set(key, {
        price: newPrice,
        count: nextCount,
        updatedAt: Date.now(),
      });
    }
  }

  clearOverrideHistory(customerId, changedItems = []) {
    if (!customerId || !Array.isArray(changedItems) || changedItems.length === 0) {
      return;
    }

    for (const item of changedItems) {
      const prodId = item.productId || item.id;
      if (!prodId) continue;
      const key = this.makeKey(customerId, prodId);
      this.storage.delete(key);
    }
  }
}

describe('Kiểm thử cơ chế theo dõi vết đổi giá riêng (PriceOverrideHistory)', () => {
  let tracker;
  const customerId = 'cust_test_123';
  const productId = 'prod_thit_bo';

  beforeEach(() => {
    tracker = new PriceOverrideTracker();
  });

  it('Lần 1: Chọn "Chỉ lần này" -> Ghi nhận count = 1, chưa báo gợi ý', () => {
    const changedItems = [{ productId, productName: 'Thịt bò', newPrice: 200000 }];

    // Kiểm tra trước khi chọn
    const streak = tracker.checkStreakBeforeOneTime(customerId, changedItems);
    expect(streak).toHaveLength(0);

    // Ghi nhận lần 1
    tracker.recordOneTimeOverride(customerId, changedItems);

    const record = tracker.storage.get(tracker.makeKey(customerId, productId));
    expect(record).toBeDefined();
    expect(record.count).toBe(1);
    expect(record.price).toBe(200000);
  });

  it('Lần 2: Chọn tiếp "Chỉ lần này" với cùng mức giá -> Tăng count = 2, chưa báo gợi ý', () => {
    const changedItems = [{ productId, productName: 'Thịt bò', newPrice: 200000 }];

    // Lần 1
    tracker.recordOneTimeOverride(customerId, changedItems);

    // Chuẩn bị lần 2
    const streakBeforeSecond = tracker.checkStreakBeforeOneTime(customerId, changedItems);
    expect(streakBeforeSecond).toHaveLength(0); // Mới 1 lần trước, chưa đủ 2

    // Ghi nhận lần 2
    tracker.recordOneTimeOverride(customerId, changedItems);

    const record = tracker.storage.get(tracker.makeKey(customerId, productId));
    expect(record.count).toBe(2);
    expect(record.price).toBe(200000);
  });

  it('Lần 3: Chọn "Chỉ lần này" cùng mức giá -> Phát hiện 2 lần trước cùng giá và bật thông báo gợi ý', () => {
    const changedItems = [{ productId, productName: 'Thịt bò', newPrice: 200000 }];

    // Giả lập đã qua 2 lần trước
    tracker.recordOneTimeOverride(customerId, changedItems);
    tracker.recordOneTimeOverride(customerId, changedItems);

    // Lần 3 bấm "Chỉ lần này" -> checkStreak phát hiện chuỗi
    const streak = tracker.checkStreakBeforeOneTime(customerId, changedItems);
    expect(streak).toHaveLength(1);
    expect(streak[0].productId).toBe(productId);
    expect(streak[0].price).toBe(200000);
    expect(streak[0].count).toBe(2);
  });

  it('Khi người dùng chọn "Cập nhật từ bây giờ" -> Xóa vết lịch sử để không gợi ý lặp lại', () => {
    const changedItems = [{ productId, productName: 'Thịt bò', newPrice: 200000 }];

    tracker.recordOneTimeOverride(customerId, changedItems);
    tracker.recordOneTimeOverride(customerId, changedItems);

    // Xác nhận đã có chuỗi
    expect(tracker.checkStreakBeforeOneTime(customerId, changedItems)).toHaveLength(1);

    // Người dùng đồng ý chuyển sang "Cập nhật từ bây giờ"
    tracker.clearOverrideHistory(customerId, changedItems);

    // Vết đã bị xóa sạch
    const record = tracker.storage.get(tracker.makeKey(customerId, productId));
    expect(record).toBeUndefined();
    expect(tracker.checkStreakBeforeOneTime(customerId, changedItems)).toHaveLength(0);
  });

  it('Đổi sang giá khác -> Chuỗi được reset về 1 với giá mới, không kích hoạt cảnh báo sai', () => {
    const item200 = [{ productId, productName: 'Thịt bò', newPrice: 200000 }];
    const item210 = [{ productId, productName: 'Thịt bò', newPrice: 210000 }];

    // Lần 1: 200k
    tracker.recordOneTimeOverride(customerId, item200);
    // Lần 2: Đổi sang 210k
    tracker.recordOneTimeOverride(customerId, item210);

    const record = tracker.storage.get(tracker.makeKey(customerId, productId));
    expect(record.count).toBe(1);
    expect(record.price).toBe(210000);

    // Kiểm tra không có streak cho cả 200k và 210k
    expect(tracker.checkStreakBeforeOneTime(customerId, item210)).toHaveLength(0);
  });
});
