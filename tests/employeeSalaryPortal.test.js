// meat-management-be/tests/employeeSalaryPortal.test.js
// Kiểm thử tự động: Sinh liên kết Zalo tra cứu lương, chấm công và cổng portal bảo mật cho nhân viên
const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Tra Cứu Lương & Chấm Công Nhân Viên Qua Zalo Portal', () => {
  let testUser;
  let testToken;
  let testEmployee;
  let shareToken;

  beforeAll(async () => {
    // 1. Khởi tạo tài khoản chủ buôn
    const userRes = await createTestUser('ChuBuon_EmpSalaryPortal');
    testUser = userRes.user;
    testToken = userRes.token;

    // Cấp quyền canManageEmployees để được gọi API nhân viên
    await prisma.user.update({
      where: { id: testUser.id },
      data: { canManageEmployees: true },
    });

    // 2. Tạo nhân viên kiểm thử với mức lương cơ bản 10.000.000đ
    testEmployee = await prisma.employee.create({
      data: {
        userId: testUser.id,
        name: 'NV_NguyenVanTest',
        phone: '0988776655', // 4 số cuối: 6655
        role: 'Lọc thịt & Giao hàng',
        baseSalary: 10000000,
        isActive: true,
      },
    });

    // 3. Tạo dữ liệu chấm công trong tháng 10/2026:
    // 1 ngày nghỉ cả ngày (ABSENT)
    await prisma.attendance.create({
      data: {
        employeeId: testEmployee.id,
        date: new Date('2026-10-05T00:00:00.000Z'),
        status: 'ABSENT',
        shift: 'FULL',
        note: 'Nghỉ việc riêng gia đình',
      },
    });

    // 1 ngày làm nửa buổi (PRESENT, HALF)
    await prisma.attendance.create({
      data: {
        employeeId: testEmployee.id,
        date: new Date('2026-10-12T00:00:00.000Z'),
        status: 'PRESENT',
        shift: 'HALF',
        note: 'Về sớm khám bệnh',
      },
    });

    // 4. Tạo 1 bản ghi tạm ứng lương 2.000.000đ trong tháng 10/2026
    await prisma.salaryAdvance.create({
      data: {
        employeeId: testEmployee.id,
        amount: 2000000,
        date: new Date('2026-10-15T00:00:00.000Z'),
        note: 'Ứng tiền đóng học cho con',
      },
    });
  });

  afterAll(async () => {
    // Dọn dẹp sạch dữ liệu phát sinh trong test
    try {
      if (testEmployee) {
        await prisma.attendance.deleteMany({ where: { employeeId: testEmployee.id } });
        await prisma.salaryAdvance.deleteMany({ where: { employeeId: testEmployee.id } });
        await prisma.salaryPayment.deleteMany({ where: { employeeId: testEmployee.id } });
        await prisma.employee.delete({ where: { id: testEmployee.id } });
      }
      if (testUser) {
        await cleanupTestUser(testUser.id);
      }
    } catch (e) {
      console.warn('Lỗi dọn dẹp test employeeSalaryPortal:', e.message);
    }
  });

  it('1. Chủ buôn lấy thành công link chia sẻ Zalo tra cứu lương cho nhân viên', async () => {
    const res = await request(app)
      .get(`/api/v1/employees/${testEmployee.id}/share-link`)
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.suggestedPin).toBe('6655');
    expect(res.body.data.name).toBe('NV_NguyenVanTest');

    shareToken = res.body.data.token;
  });

  it('2. Khách vãng lai / Nhân viên xem thông tin kiểm tra PIN mà không cần tài khoản app', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/employee-salary/info/${shareToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.employeeName).toBe('NV_NguyenVanTest');
    expect(res.body.data.hasPin).toBe(true);
    expect(res.body.data.pinHint).toContain('6655');
  });

  it('3. Chặn truy cập dữ liệu lương nếu nhập sai mã PIN', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/employee-salary/data/${shareToken}?monthKey=10/2026&pin=1234`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('4. Nhân viên nhập đúng mã PIN (4 số cuối SĐT) -> Nhận đầy đủ bảng lương, chấm công và ngày nghỉ', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/employee-salary/data/${shareToken}?monthKey=10/2026&pin=6655`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { data } = res.body;
    expect(data.employee.name).toBe('NV_NguyenVanTest');
    expect(data.monthKey).toBe('10/2026');
    expect(data.totalDaysInMonth).toBe(31); // Tháng 10 có 31 ngày

    // Nghỉ 1 ngày cả ngày (-1) và 1 ngày làm nửa buổi (-0.5) => Ngày công = 31 - 1.5 = 29.5
    expect(Number(data.workingDays)).toBe(29.5);
    expect(data.stats.absentDaysCount).toBe(1);
    expect(data.stats.halfDaysCount).toBe(1);

    // Tạm ứng 2.000.000đ
    expect(data.salary.totalAdvances).toBe(2000000);
    expect(data.advances.length).toBe(1);
    expect(data.advances[0].note).toBe('Ứng tiền đóng học cho con');

    // Danh sách ngày nghỉ / biến động ca làm
    expect(data.leaves.length).toBe(2);
    expect(data.leaves.some((l) => l.status === 'ABSENT')).toBe(true);
    expect(data.leaves.some((l) => l.shift === 'HALF')).toBe(true);

    // Lương thực lĩnh lớn hơn 0 và được tính toán chính xác
    expect(data.salary.finalAmount).toBeGreaterThan(0);
  });
});
