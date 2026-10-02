import { describe, it, expect } from 'vitest';
import {
  normalizeMeatName,
  isQuantityDuplicate,
  detectDuplicateDayItems,
  detectMissingScheduleDays,
  auditExportDebtData,
  buildAuditWarningMessage,
  auditGlobalTransactionsForDuplicates,
  buildGlobalAuditWarningMessage,
  computeDuplicatesSignature,
} from '../../meat-management-fe/src/utils/debtExportAuditHelper.js';

describe('Luồng Nghiệp Vụ: Kiểm toán dữ liệu xuất công nợ khách hàng (Audit Export Debt)', () => {
  describe('1. Kiểm tra chuẩn hóa tên thịt và phát hiện số kg trùng lặp', () => {
    it('Chuẩn hóa tên thịt: loại bỏ khoảng trắng thừa và không phân biệt hoa thường', () => {
      expect(normalizeMeatName('  TÁI (BÒ)  ')).toBe('tái (bò)');
      expect(normalizeMeatName('Tái   (Bò)')).toBe('tái (bò)');
      expect(normalizeMeatName('bắp bò')).toBe('bắp bò');
    });

    it('So sánh số kg: cùng số kg được coi là trùng (lệch = 0)', () => {
      expect(isQuantityDuplicate(9.7, 9.7)).toBe(true);
      expect(isQuantityDuplicate('2.4', 2.4)).toBe(true);
    });

    it('So sánh số kg: lệch < 0.2kg được coi là trùng lặp', () => {
      // 9.7 và 9.8 (lệch 0.1 < 0.2) -> TRÙNG
      expect(isQuantityDuplicate(9.7, 9.8)).toBe(true);
      // 9.7 và 9.85 (lệch 0.15 < 0.2) -> TRÙNG
      expect(isQuantityDuplicate(9.7, 9.85)).toBe(true);
      // 9.7 và 9.6 (lệch 0.1 < 0.2) -> TRÙNG
      expect(isQuantityDuplicate(9.7, 9.6)).toBe(true);
    });

    it('So sánh số kg: lệch >= 0.2kg KHÔNG coi là trùng lặp', () => {
      // 9.7 và 10.0 (lệch 0.3 >= 0.2) -> KHÔNG TRÙNG
      expect(isQuantityDuplicate(9.7, 10.0)).toBe(false);
      // 2.4 và 3.0 (lệch 0.6 >= 0.2) -> KHÔNG TRÙNG
      expect(isQuantityDuplicate(2.4, 3.0)).toBe(false);
    });
  });

  describe('2. Phát hiện các dòng hàng bị trùng lặp trong cùng một ngày (như ảnh thực tế)', () => {
    it('Phát hiện chính xác trùng lặp TÁI (BÒ) 9.7kg và BẮP BÒ 2.4kg trong ngày 19/09', () => {
      // Dữ liệu mô phỏng đúng bảng thực tế trong ảnh 2 của người dùng
      const days = [
        {
          dateKey: '19/09/2026',
          displayDate: '19/09',
          entries: [
            { type: 'DELIVERY', name: 'TÁI (BÒ)', quantity: 9.7, price: 250000, amount: 2425000 },
            { type: 'DELIVERY', name: 'LẠM', quantity: 6.0, price: 160000, amount: 960000 },
            { type: 'DELIVERY', name: 'GẦU BÒ', quantity: 11.3, price: 210000, amount: 2373000 },
            { type: 'DELIVERY', name: 'TÁI (BÒ)', quantity: 9.7, price: 250000, amount: 2425000 }, // Trùng dòng 1
            { type: 'DELIVERY', name: 'XG BÒ', quantity: 15.0, price: 20000, amount: 300000 },
            { type: 'DELIVERY', name: 'BẮP BÒ', quantity: 2.4, price: 300000, amount: 720000 },
            { type: 'DELIVERY', name: 'BẮP BÒ', quantity: 2.4, price: 300000, amount: 720000 }, // Trùng dòng 6
            { type: 'DAY_TOTAL', name: 'TỔNG', amount: 9923000 },
          ],
        },
      ];

      const duplicates = detectDuplicateDayItems(days);
      expect(duplicates.length).toBe(1);
      expect(duplicates[0].displayDate).toBe('19/09');
      expect(duplicates[0].groups.length).toBe(2);

      // Nhóm 1: TÁI (BÒ)
      const taiGroup = duplicates[0].groups.find((g) => g.productName.includes('TÁI'));
      expect(taiGroup).toBeDefined();
      expect(taiGroup.items.length).toBe(2);
      expect(taiGroup.quantities).toEqual([9.7, 9.7]);

      // Nhóm 2: BẮP BÒ
      const bapGroup = duplicates[0].groups.find((g) => g.productName.includes('BẮP'));
      expect(bapGroup).toBeDefined();
      expect(bapGroup.items.length).toBe(2);
      expect(bapGroup.quantities).toEqual([2.4, 2.4]);
    });

    it('Không cảnh báo trùng nếu cùng món thịt nhưng nằm ở các ngày khác nhau', () => {
      const days = [
        {
          dateKey: '19/09/2026',
          displayDate: '19/09',
          entries: [
            { type: 'DELIVERY', name: 'TÁI (BÒ)', quantity: 9.7, price: 250000, amount: 2425000 },
          ],
        },
        {
          dateKey: '20/09/2026',
          displayDate: '20/09',
          entries: [
            { type: 'DELIVERY', name: 'TÁI (BÒ)', quantity: 9.7, price: 250000, amount: 2425000 },
          ],
        },
      ];

      const duplicates = detectDuplicateDayItems(days);
      expect(duplicates.length).toBe(0);
    });

    it('Bỏ qua các dòng tiền hàng ghi nhanh không có số lượng kg hoặc dòng thanh toán', () => {
      const days = [
        {
          dateKey: '19/09/2026',
          displayDate: '19/09',
          entries: [
            { type: 'DELIVERY', name: 'TIỀN HÀNG', quantity: null, amount: 500000 },
            { type: 'DELIVERY', name: 'TIỀN HÀNG', quantity: null, amount: 500000 },
            { type: 'PAYMENT', name: 'ĐÃ THU', quantity: null, amount: 1000000 },
          ],
        },
      ];

      const duplicates = detectDuplicateDayItems(days);
      expect(duplicates.length).toBe(0);
    });
  });

  describe('3. Cảnh báo các ngày không có lịch trong tháng đối với nhà hàng đặt hàng thường xuyên (> 15 lần/tháng)', () => {
    it('Chỉ cảnh báo khi khách hàng đặt thường xuyên trên 15 lần 1 tháng', () => {
      // Khách vãng lai: chỉ đặt 5 ngày trong tháng 09/2026
      const transactions = [
        { date: '2026-09-01T08:00:00.000Z' },
        { date: '2026-09-02T08:00:00.000Z' },
        { date: '2026-09-03T08:00:00.000Z' },
        { date: '2026-09-04T08:00:00.000Z' },
        { date: '2026-09-05T08:00:00.000Z' },
      ];

      const result = detectMissingScheduleDays({
        activeTab: 'month',
        selectedMonth: '09/2026',
        isExportMonth: true,
        transactions,
        days: [],
      });

      expect(result.isFrequentCustomer).toBe(false);
      expect(result.missingDays.length).toBe(0);
    });

    it('Khách hàng quen đặt 20 ngày trong tháng 09/2026 (> 15 lần): Phát hiện danh sách các ngày không có đơn', () => {
      // Tạo 20 ngày có đơn trong tháng 9 (từ ngày 01 đến 20)
      const transactions = [];
      for (let d = 1; d <= 20; d++) {
        const dd = d.toString().padStart(2, '0');
        transactions.push({ date: `2026-09-${dd}T08:00:00.000Z` });
      }

      const result = detectMissingScheduleDays({
        activeTab: 'month',
        selectedMonth: '09/2026',
        isExportMonth: true,
        transactions,
        days: [],
      });

      expect(result.isFrequentCustomer).toBe(true);
      expect(result.orderCount).toBe(20);
      // Tháng 9 có 30 ngày, các ngày từ 21 đến 30 là các ngày không có đơn
      expect(result.missingDays.length).toBe(10);
      expect(result.missingDays).toContain('21/09');
      expect(result.missingDays).toContain('30/09');
    });

    it('Không kích hoạt kiểm tra ngày trống nếu không phải là lọc theo tháng', () => {
      // Khoảng ngày lọc lẻ 3 ngày: 10/09/2026 đến 12/09/2026
      const transactions = [];
      for (let d = 1; d <= 20; d++) {
        const dd = d.toString().padStart(2, '0');
        transactions.push({ date: `2026-09-${dd}T08:00:00.000Z` });
      }

      const result = detectMissingScheduleDays({
        activeTab: 'day',
        fromDate: '10/09/2026',
        toDate: '12/09/2026',
        selectedMonth: '',
        isExportMonth: false,
        transactions,
        days: [],
      });

      expect(result.isMonthFilter).toBe(false);
      expect(result.missingDays.length).toBe(0);
    });
  });

  describe('4. Hàm tổng hợp auditExportDebtData và tạo thông điệp pop-up', () => {
    it('Tạo thông điệp cảnh báo đầy đủ khi vừa có mục trùng vừa có ngày thiếu lịch', () => {
      const days = [
        {
          dateKey: '19/09/2026',
          displayDate: '19/09',
          entries: [
            { type: 'DELIVERY', name: 'TÁI (BÒ)', quantity: 9.7, price: 250000, amount: 2425000 },
            { type: 'DELIVERY', name: 'TÁI (BÒ)', quantity: 9.7, price: 250000, amount: 2425000 },
          ],
        },
      ];

      const transactions = [];
      for (let d = 1; d <= 18; d++) {
        const dd = d.toString().padStart(2, '0');
        transactions.push({ date: `2026-09-${dd}T08:00:00.000Z` });
      }

      const audit = auditExportDebtData({
        days,
        transactions,
        activeTab: 'month',
        selectedMonth: '09/2026',
        isExportMonth: true,
      });

      expect(audit.hasWarning).toBe(true);
      expect(audit.hasDuplicates).toBe(true);
      expect(audit.hasMissingDays).toBe(true);
      expect(audit.warningMessage).toContain('📌 CÁC MỤC NGHI TRÙNG LẶP TRONG CÙNG MỘT NGÀY:');
      expect(audit.warningMessage).toContain('TÁI (BÒ)');
      expect(audit.warningMessage).toContain('📌 CÁC NGÀY KHÔNG CÓ LỊCH / ĐƠN HÀNG TRONG THÁNG 09/2026:');
      expect(audit.warningMessage).toContain('Bạn có chắc chắn muốn tiếp tục tải ảnh bảng kê này không?');
    });

    it('Không cảnh báo (hasWarning = false) nếu dữ liệu hoàn hảo không trùng và không thiếu', () => {
      const days = [
        {
          dateKey: '19/09/2026',
          displayDate: '19/09',
          entries: [
            { type: 'DELIVERY', name: 'TÁI (BÒ)', quantity: 9.7, price: 250000, amount: 2425000 },
            { type: 'DELIVERY', name: 'LẠM', quantity: 6.0, price: 160000, amount: 960000 },
          ],
        },
      ];

      const audit = auditExportDebtData({
        days,
        transactions: [],
        activeTab: 'day',
        fromDate: '19/09/2026',
        toDate: '19/09/2026',
        selectedMonth: '',
        isExportMonth: false,
      });

      expect(audit.hasWarning).toBe(false);
      expect(audit.warningMessage).toBe('');
    });
  });

  describe('5. Kiểm tra ngầm toàn cục trùng lặp đơn hàng trong ngày (Global Background Audit)', () => {
    const mockCustomers = [
      { id: 'cust_1', name: 'Quán Phở Anh Tuấn', phone: '0912345678' },
      { id: 'cust_2', name: 'Nhà Hàng Chị Hoa', phone: '0987654321' },
      { id: 'cust_3', name: 'Bún Bò Huế Chị Lan', phone: '0900112233' },
    ];

    it('Phát hiện chính xác khách hàng bị trùng đơn khi 2 món thịt trùng nằm ở 2 đơn khác nhau trong cùng 1 ngày', () => {
      const todayISO = new Date().toISOString();
      const transactions = [
        // Khách 1 - Đơn sáng: 9.7kg Tái bò
        {
          id: 'tx_1',
          customerId: 'cust_1',
          date: todayISO,
          items: [{ productName: 'TÁI (BÒ)', quantity: 9.7, price: 250000, amount: 2425000 }],
        },
        // Khách 1 - Đơn chiều (nhập trùng): 9.7kg Tái bò
        {
          id: 'tx_2',
          customerId: 'cust_1',
          date: todayISO,
          items: [{ productName: 'TÁI (BÒ)', quantity: 9.7, price: 250000, amount: 2425000 }],
        },
        // Khách 2 - Bình thường, không trùng
        {
          id: 'tx_3',
          customerId: 'cust_2',
          date: todayISO,
          items: [
            { productName: 'GẦU BÒ', quantity: 5.0, price: 210000, amount: 1050000 },
            { productName: 'NẠM BÒ', quantity: 3.0, price: 160000, amount: 480000 },
          ],
        },
      ];

      const duplicates = auditGlobalTransactionsForDuplicates({
        transactions,
        customers: mockCustomers,
      });

      expect(duplicates.length).toBe(1);
      expect(duplicates[0].customerId).toBe('cust_1');
      expect(duplicates[0].customerName).toBe('Quán Phở Anh Tuấn');
      expect(duplicates[0].groups.length).toBe(1);
      expect(duplicates[0].groups[0].productName).toBe('TÁI (BÒ)');
      expect(duplicates[0].groups[0].quantities).toEqual([9.7, 9.7]);
    });

    it('Phát hiện nhiều khách hàng cùng bị trùng đơn trong ngày', () => {
      const todayISO = new Date().toISOString();
      const transactions = [
        // Khách 1 bị trùng 2 dòng Bắp bò 2.4kg
        {
          id: 'tx_1',
          customerId: 'cust_1',
          date: todayISO,
          items: [
            { productName: 'BẮP BÒ', quantity: 2.4, price: 300000, amount: 720000 },
            { productName: 'BẮP BÒ', quantity: 2.4, price: 300000, amount: 720000 },
          ],
        },
        // Khách 2 bị trùng 2 dòng Gầu bò (lệch 0.1kg < 0.2kg: 5.0kg và 5.1kg)
        {
          id: 'tx_2',
          customerId: 'cust_2',
          date: todayISO,
          items: [
            { productName: 'GẦU BÒ', quantity: 5.0, price: 210000, amount: 1050000 },
            { productName: 'GẦU BÒ', quantity: 5.1, price: 210000, amount: 1071000 },
          ],
        },
      ];

      const duplicates = auditGlobalTransactionsForDuplicates({
        transactions,
        customers: mockCustomers,
      });

      expect(duplicates.length).toBe(2);
      const names = duplicates.map((d) => d.customerName);
      expect(names).toContain('Quán Phở Anh Tuấn');
      expect(names).toContain('Nhà Hàng Chị Hoa');
    });

    it('Tạo chữ ký trùng lặp computeDuplicatesSignature chính xác và ổn định để chống spam popup', () => {
      const dups = [
        {
          customerId: 'cust_1',
          dateKey: '02/10/2026',
          groups: [{ productName: 'TÁI (BÒ)', quantities: [9.7, 9.7] }],
        },
      ];

      const sig1 = computeDuplicatesSignature(dups);
      const sig2 = computeDuplicatesSignature(dups);
      expect(sig1).toBe(sig2);
      expect(sig1).toContain('cust_1');
      expect(sig1).toContain('TÁI (BÒ)');

      // Khi thêm món trùng mới -> chữ ký thay đổi
      const dupsUpdated = [
        ...dups,
        {
          customerId: 'cust_2',
          dateKey: '02/10/2026',
          groups: [{ productName: 'GẦU BÒ', quantities: [5.0, 5.1] }],
        },
      ];
      const sigUpdated = computeDuplicatesSignature(dupsUpdated);
      expect(sigUpdated).not.toBe(sig1);
    });

    it('Tạo thông điệp cảnh báo pop-up toàn cục chuyên nghiệp buildGlobalAuditWarningMessage', () => {
      const dups = [
        {
          customerId: 'cust_1',
          customerName: 'Quán Phở Anh Tuấn',
          displayDate: '02/10',
          groups: [{ productName: 'TÁI (BÒ)', quantities: [9.7, 9.7], items: [{}, {}] }],
        },
      ];

      const message = buildGlobalAuditWarningMessage(dups);
      expect(message).toContain('⚠️ PHÁT HIỆN TRÙNG LẶP ĐƠN HÀNG TRONG NGÀY:');
      expect(message).toContain('Quán Phở Anh Tuấn');
      expect(message).toContain('TÁI (BÒ)');
      expect(message).toContain('9.7kg và 9.7kg');
      expect(message).toContain('Bạn có muốn mở kiểm tra chi tiết các đơn hàng này không?');
    });
  });
});
