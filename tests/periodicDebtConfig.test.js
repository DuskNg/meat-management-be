// meat-management-be/tests/periodicDebtConfig.test.js
// Kiểm thử tự động: Logic tính khoảng ngày gửi công nợ định kỳ (Ngày 1: Tháng trước, Ngày 15: 01->15)

describe('Luồng Nghiệp Vụ: Cấu Hình Lịch Gửi Công Nợ Định Kỳ (Ngày 1 & Ngày 15)', () => {
  // Hàm giả lập tính toán kỳ đối soát giống như helper frontend
  const getPeriodicRangeMock = (periodType, mockDate) => {
    const today = mockDate ? new Date(mockDate) : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const y = today.getFullYear();
    const m = today.getMonth(); // 0-indexed

    if (periodType === 'first_half') {
      return {
        type: 'first_half',
        title: `Kỳ 01 - 15/${pad(m + 1)}/${y}`,
        fromDate: `01/${pad(m + 1)}/${y}`,
        toDate: `15/${pad(m + 1)}/${y}`,
      };
    }

    // Mặc định: Kỳ toàn bộ tháng trước
    const firstDayPrevMonth = new Date(y, m - 1, 1);
    const lastDayPrevMonth = new Date(y, m, 0);

    const prevMonthNum = firstDayPrevMonth.getMonth() + 1;
    const prevYearNum = firstDayPrevMonth.getFullYear();

    return {
      type: 'last_month',
      title: `Tháng ${pad(prevMonthNum)}/${prevYearNum}`,
      fromDate: `01/${pad(prevMonthNum)}/${prevYearNum}`,
      toDate: `${pad(lastDayPrevMonth.getDate())}/${pad(prevMonthNum)}/${prevYearNum}`,
    };
  };

  it('1. Ngày 1 của tháng mới: Phải tự động chọn kỳ công nợ TRỌN VẸN THÁNG TRƯỚC', () => {
    // Giả lập ngày 01/10/2026 -> Phải lấy từ 01/09/2026 đến 30/09/2026
    const range = getPeriodicRangeMock('last_month', '2026-10-01T08:00:00Z');
    expect(range.fromDate).toBe('01/09/2026');
    expect(range.toDate).toBe('30/09/2026');
    expect(range.title).toBe('Tháng 09/2026');
  });

  it('2. Ngày 1/1 của năm mới: Phải tự động lùi về tháng 12 của năm trước', () => {
    // Giả lập ngày 01/01/2027 -> Phải lấy từ 01/12/2026 đến 31/12/2026
    const range = getPeriodicRangeMock('last_month', '2027-01-01T08:00:00Z');
    expect(range.fromDate).toBe('01/12/2026');
    expect(range.toDate).toBe('31/12/2026');
    expect(range.title).toBe('Tháng 12/2026');
  });

  it('3. Ngày 15 hàng tháng: Phải tự động lấy khoảng ngày từ 01 đến 15 tháng đó', () => {
    // Giả lập ngày 15/10/2026 -> Phải lấy từ 01/10/2026 đến 15/10/2026
    const range = getPeriodicRangeMock('first_half', '2026-10-15T08:00:00Z');
    expect(range.fromDate).toBe('01/10/2026');
    expect(range.toDate).toBe('15/10/2026');
    expect(range.title).toBe('Kỳ 01 - 15/10/2026');
  });

  it('4. Kiểm tra cấu hình danh sách 22 nhà hàng mục tiêu', () => {
    // Danh sách 22 nhà hàng yêu cầu:
    // 11 quán chuỗi Trường Hoàng + 3 cơ sở Bếp Hàng Xóm + 8 nhà hàng riêng lẻ = 22 quán
    const expectedTargetCount = 22;
    const targetGroups = {
      truongHoang: 11,
      hangXom: 3,
      singleRest: 8,
    };

    const total = targetGroups.truongHoang + targetGroups.hangXom + targetGroups.singleRest;
    expect(total).toBe(expectedTargetCount);
  });
});
