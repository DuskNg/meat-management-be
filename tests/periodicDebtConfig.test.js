// meat-management-be/tests/periodicDebtConfig.test.js
// Kiểm thử tự động: Cấu hình và API gửi công nợ định kỳ linh hoạt theo khách hàng
const request = require('supertest');
const { app } = require('../src/index');
const {
  createTestUser,
  createTestCustomer,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Cấu Hình Lịch Gửi Công Nợ Định Kỳ (Linh Hoạt Theo Khách Hàng)', () => {
  let testUser;
  let testToken;
  let testCustomer1;
  let testCustomer2;

  beforeAll(async () => {
    const userRes = await createTestUser('ChuBuon_PeriodicDebt');
    testUser = userRes.user;
    testToken = userRes.token;

    testCustomer1 = await createTestCustomer(testUser.id, 'NhaHang_TruongHoang_1');
    testCustomer2 = await createTestCustomer(testUser.id, 'QuanAn_ChiThuyNga');
  });

  afterAll(async () => {
    await cleanupTestUser(testUser?.id);
  });

  // ─── 1. KIỂM TRA LOGIC TÍNH KHOẢNG NGÀY ĐỐI SOÁT ───
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
    const range = getPeriodicRangeMock('last_month', '2026-10-01T08:00:00Z');
    expect(range.fromDate).toBe('01/09/2026');
    expect(range.toDate).toBe('30/09/2026');
    expect(range.title).toBe('Tháng 09/2026');
  });

  it('2. Ngày 15 hàng tháng: Phải tự động lấy khoảng ngày từ 01 đến 15 tháng đó', () => {
    const range = getPeriodicRangeMock('first_half', '2026-10-15T08:00:00Z');
    expect(range.fromDate).toBe('01/10/2026');
    expect(range.toDate).toBe('15/10/2026');
    expect(range.title).toBe('Kỳ 01 - 15/10/2026');
  });

  // ─── 2. KIỂM THỬ API QUẢN LÝ CẤU HÌNH NHẮC NỢ (CRUD) ───
  let createdReminderId;

  it('3. Thêm khách hàng vào danh sách nhắc nợ với ngày áp dụng tùy chỉnh', async () => {
    const res = await request(app)
      .post('/api/v1/periodic-reminders')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        customerId: testCustomer1.id,
        reminderDays: '1,15',
        groupName: 'Chuỗi Trường Hoàng',
        notes: 'Gửi bảng kê riêng từng quán',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.customerId).toBe(testCustomer1.id);
    expect(res.body.data.reminderDays).toBe('1,15');
    expect(res.body.data.groupName).toBe('Chuỗi Trường Hoàng');

    createdReminderId = res.body.data.id;
  });

  it('4. Lấy danh sách cấu hình nhắc nợ phải chứa khách hàng vừa thêm', async () => {
    const res = await request(app)
      .get('/api/v1/periodic-reminders')
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);

    const found = res.body.data.find((item) => item.customerId === testCustomer1.id);
    expect(found).toBeDefined();
    expect(found.customer?.name).toBe(testCustomer1.name);
  });

  it('5. Cập nhật ngày nhắc nợ và nhóm của khách hàng thành công', async () => {
    const res = await request(app)
      .put(`/api/v1/periodic-reminders/${createdReminderId}`)
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        reminderDays: '15',
        groupName: 'Nhóm VIP',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.reminderDays).toBe('15');
    expect(res.body.data.groupName).toBe('Nhóm VIP');
  });

  it('6. Xóa khách hàng khỏi danh sách nhắc nợ', async () => {
    const res = await request(app)
      .delete(`/api/v1/periodic-reminders/${createdReminderId}`)
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Xác nhận đã xóa trong danh sách
    const checkRes = await request(app)
      .get('/api/v1/periodic-reminders')
      .set('Authorization', `Bearer ${testToken}`);

    const found = checkRes.body.data.find((item) => item.id === createdReminderId);
    expect(found).toBeUndefined();
  });
});
