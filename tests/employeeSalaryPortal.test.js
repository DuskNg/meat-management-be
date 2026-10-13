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

  it('5. Thêm mới nhân viên mới qua API POST /api/v1/employees thành công', async () => {
    const res = await request(app)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        name: 'Quang Test Mới',
        phone: '0912345678',
        role: 'Giao hàng',
        address: '123 Đường Test',
        baseSalary: 13000000,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe('Quang Test Mới');
    expect(Number(res.body.data.baseSalary)).toBe(13000000);

    // Dọn dẹp bản ghi test
    await prisma.employee.delete({ where: { id: res.body.data.id } });
  });

  it('6. Ghi nhận nhân viên xin nghỉ qua API POST /api/v1/employees/leave và tự động trừ buổi lương', async () => {
    // Ghi nhận nghỉ 1 buổi ngày 20/10/2026 cho testEmployee (lương 10.000.000đ, tháng 10 có 31 ngày => 1 ngày ~ 322.581đ)
    const leaveRes = await request(app)
      .post('/api/v1/employees/leave')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        employeeId: testEmployee.id,
        date: '2026-10-20',
        shift: 'FULL',
        note: 'Bận việc gia đình',
      });

    expect(leaveRes.status).toBe(200);
    expect(leaveRes.body.success).toBe(true);
    expect(leaveRes.body.data.status).toBe('ABSENT');

    // Kiểm tra danh sách nhân viên GET /api/v1/employees?monthKey=10/2026
    const empRes = await request(app)
      .get('/api/v1/employees?monthKey=10/2026')
      .set('Authorization', `Bearer ${testToken}`);

    expect(empRes.status).toBe(200);
    const targetEmp = empRes.body.data.find((e) => e.id === testEmployee.id);
    expect(targetEmp).toBeDefined();
    // Trước đó có 1 ngày ABSENT (1 công) + 1 ngày HALF (0.5 công), cộng thêm ngày 20/10 (1 công) => Tổng 2.5 ngày nghỉ
    expect(targetEmp.leaveDays).toBe(2.5);
    expect(targetEmp.leaveDeduction).toBeGreaterThan(0);
    expect(Number(targetEmp.remainingSalary)).toBeLessThan(Number(targetEmp.baseSalary));

    // Xóa ngày nghỉ vừa tạo để dọn dẹp
    const delRes = await request(app)
      .delete(`/api/v1/employees/leave/${leaveRes.body.data.id}`)
      .set('Authorization', `Bearer ${testToken}`);

    expect(delRes.status).toBe(200);
    expect(delRes.body.success).toBe(true);
  });

  it('7. Chủ buôn lấy link cổng nhân sự chung, nhân viên vào cổng chung tra cứu bảng lương bảo mật bằng mã PIN', async () => {
    // Chủ buôn lấy link chung
    const linkRes = await request(app)
      .get('/api/v1/employees/general-share-link')
      .set('Authorization', `Bearer ${testToken}`);

    expect(linkRes.status).toBe(200);
    expect(linkRes.body.success).toBe(true);
    expect(linkRes.body.data.token).toBeDefined();

    const generalToken = linkRes.body.data.token;

    // Nhân viên mở link chung lấy danh sách
    const infoRes = await request(app)
      .get(`/api/v1/portal/staff/info/${generalToken}`);

    expect(infoRes.status).toBe(200);
    expect(infoRes.body.data.isGeneral).toBe(true);
    expect(infoRes.body.data.employees.length).toBeGreaterThan(0);
    expect(infoRes.body.data.employees.some((e) => e.id === testEmployee.id)).toBe(true);

    // Nhân viên nhập sai PIN -> Bị chặn 403
    const wrongPinRes = await request(app)
      .get(`/api/v1/portal/staff/salary/${generalToken}?employeeId=${testEmployee.id}&monthKey=10/2026&pin=9999`);

    expect(wrongPinRes.status).toBe(403);
    expect(wrongPinRes.body.success).toBe(false);

    // Nhân viên nhập đúng PIN (4 số cuối SĐT 6655) -> Mở bảng lương thành công
    const correctPinRes = await request(app)
      .get(`/api/v1/portal/staff/salary/${generalToken}?employeeId=${testEmployee.id}&monthKey=10/2026&pin=6655`);

    expect(correctPinRes.status).toBe(200);
    expect(correctPinRes.body.success).toBe(true);
    expect(correctPinRes.body.data.employee.name).toBe('NV_NguyenVanTest');
    expect(correctPinRes.body.data.salary.finalAmount).toBeGreaterThan(0);
  });
});
