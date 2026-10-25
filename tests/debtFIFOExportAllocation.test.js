// meat-management-be/tests/debtFIFOExportAllocation.test.js
import { describe, it, expect } from 'vitest';
import {
  allocateDebtFIFO,
  buildExportDayGroupsWithFIFO,
  toDateKey,
  isReturnPayment,
} from '../../meat-management-fe/src/utils/debtAllocationHelper.js';

describe('Luồng Nghiệp Vụ: Đồng Bộ Phân Bổ Nợ FIFO Cho Module Xuất File & Ảnh Công Nợ', () => {
  it('1. Trả nợ dồn: Tiền trả ở tháng mới được cấn trừ dồn về các ngày/tháng cũ còn thiếu, KHÔNG trừ lẹm vào tháng mới', () => {
    // Giả lập lịch sử giao dịch:
    // - Ngày 15/07: Khách mua 50.000.000đ tiền thịt
    // - Ngày 01/08: Khách mua 30.000.000đ tiền thịt
    // - Ngày 05/08: Khách thanh toán 50.000.000đ (trả dồn nợ cũ)
    const transactions = [
      {
        id: 'trans_jul_15',
        date: '2026-07-15T08:00:00.000Z',
        totalAmount: 50000000,
        items: [{ productName: 'Thịt ba chỉ', quantity: 250, price: 200000, amount: 50000000 }],
      },
      {
        id: 'trans_aug_01',
        date: '2026-08-01T08:00:00.000Z',
        totalAmount: 30000000,
        items: [{ productName: 'Sườn non', quantity: 150, price: 200000, amount: 30000000 }],
      },
    ];

    const payments = [
      {
        id: 'pay_aug_05',
        paidAt: '2026-08-05T10:00:00.000Z',
        amount: 50000000,
        note: null, // Thu nợ chung, không ghi chú tháng cụ thể
      },
    ];

    // Kiểm tra thuật toán allocateDebtFIFO
    const { remainingDebtMap, remainingPayMap, transAllocations } = allocateDebtFIFO(transactions, payments);

    // Khoản nợ ngày 15/07 phải được trả sạch (= 0)
    expect(remainingDebtMap['trans_jul_15']).toBe(0);
    // Khoản nợ ngày 01/08 chưa được trả, vẫn còn nguyên 30.000.000đ
    expect(remainingDebtMap['trans_aug_01']).toBe(30000000);
    // Khoản thanh toán 50.000.000đ đã được dùng hết để trả cho đơn 15/07
    expect(remainingPayMap['pay_aug_05']).toBe(0);
    expect(transAllocations['trans_jul_15']).toHaveLength(1);
    expect(transAllocations['trans_jul_15'][0].amount).toBe(50000000);

    // KHI XUẤT FILE THÁNG 8 (01/08/2026 - 31/08/2026):
    const fromDAug = new Date(2026, 7, 1, 0, 0, 0, 0); // Tháng 8 (index 7)
    const toDAug = new Date(2026, 7, 31, 23, 59, 59, 999);
    const exportAug = buildExportDayGroupsWithFIFO({
      transList: transactions,
      payList: payments,
      fromD: fromDAug,
      toD: toDAug,
      monthStr: '08/2026',
    });

    // Tháng 8 chỉ có 30.000.000đ tiền thịt, ĐÃ TRẢ PHẢI LÀ 0đ, CÒN NỢ 30.000.000đ
    // Tuyệt đối không được lấy 50.000.000đ của tháng 7 trừ vào tháng 8!
    expect(exportAug.totalMeatAmount).toBe(30000000);
    expect(exportAug.totalPaymentAmount).toBe(0);
    expect(exportAug.finalDebt).toBe(30000000);
    expect(exportAug.wholeMonthDebt).toBe(30000000);

    // KHI XUẤT FILE THÁNG 7 (01/07/2026 - 31/07/2026):
    const fromDJul = new Date(2026, 6, 1, 0, 0, 0, 0); // Tháng 7 (index 6)
    const toDJul = new Date(2026, 6, 31, 23, 59, 59, 999);
    const exportJul = buildExportDayGroupsWithFIFO({
      transList: transactions,
      payList: payments,
      fromD: fromDJul,
      toD: toDJul,
      monthStr: '07/2026',
    });

    // Tháng 7 có 50.000.000đ tiền thịt, và đã được trả sạch 50.000.000đ -> Còn nợ 0đ
    expect(exportJul.totalMeatAmount).toBe(50000000);
    expect(exportJul.totalPaymentAmount).toBe(50000000);
    expect(exportJul.finalDebt).toBe(0);
    expect(exportJul.wholeMonthDebt).toBe(0);
    // Bảng kê hàng ngày không bị chèn các dòng ĐÃ THU lặp lại
    expect(exportJul.sortedDays.every(d => d.entries.every(e => e.type !== 'PAYMENT'))).toBe(true);
    // Bảng thanh toán mở ngoặc ghi rõ ngày thu nợ
    expect(exportJul.paymentSummaryText).toBe('Khoản thu ngày 05/08');
  });

  it('2. Trả nợ vượt số dư nợ cũ (trả dư/cuốn chiếu sang tháng mới): Khoản dôi ra được trừ tiếp cho tháng mới', () => {
    // Tháng 7 nợ 50tr, Tháng 8 nợ 30tr
    // Ngày 05/08 khách trả 70.000.000đ
    // -> 50tr dồn trả sạch Tháng 7, 20tr còn lại khấu trừ tiếp cho Tháng 8
    const transactions = [
      {
        id: 't_jul',
        date: '2026-07-20T08:00:00.000Z',
        totalAmount: 50000000,
        items: [{ productName: 'Thịt heo', quantity: 200, price: 250000, amount: 50000000 }],
      },
      {
        id: 't_aug',
        date: '2026-08-02T08:00:00.000Z',
        totalAmount: 30000000,
        items: [{ productName: 'Thịt bò', quantity: 100, price: 300000, amount: 30000000 }],
      },
    ];

    const payments = [
      {
        id: 'p_aug_70m',
        paidAt: '2026-08-05T09:00:00.000Z',
        amount: 70000000,
        note: '',
      },
    ];

    const fromDAug = new Date(2026, 7, 1, 0, 0, 0, 0);
    const toDAug = new Date(2026, 7, 31, 23, 59, 59, 999);
    const exportAug = buildExportDayGroupsWithFIFO({
      transList: transactions,
      payList: payments,
      fromD: fromDAug,
      toD: toDAug,
      monthStr: '08/2026',
    });

    // Tháng 8: Tiền thịt 30tr, nhận phần dư 20tr từ đợt trả 70tr -> Còn nợ 10tr
    expect(exportAug.totalMeatAmount).toBe(30000000);
    expect(exportAug.totalPaymentAmount).toBe(20000000);
    expect(exportAug.finalDebt).toBe(10000000);
  });

  it('3. Ưu tiên thanh toán có ghi chú đích danh tháng/ngày cụ thể trước FIFO chung', () => {
    const transactions = [
      {
        id: 't_day1',
        date: '2026-08-01T08:00:00.000Z',
        totalAmount: 5000000,
      },
      {
        id: 't_day2',
        date: '2026-08-02T08:00:00.000Z',
        totalAmount: 5000000,
      },
    ];

    const payments = [
      // Khách chuyển trả đích danh cho đơn ngày 02/08
      {
        id: 'p_for_day2',
        paidAt: '2026-08-03T10:00:00.000Z',
        amount: 5000000,
        note: 'Thanh toán nợ ngày 02/08/2026',
      },
    ];

    const { remainingDebtMap } = allocateDebtFIFO(transactions, payments);
    // Đơn ngày 02/08 phải được trả hết vì khớp đích danh
    expect(remainingDebtMap['t_day2']).toBe(0);
    // Đơn ngày 01/08 vẫn còn nợ
    expect(remainingDebtMap['t_day1']).toBe(5000000);
  });
});
