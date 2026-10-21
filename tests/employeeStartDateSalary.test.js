// meat-management-be/tests/employeeStartDateSalary.test.js
// Kiểm thử tự động: Lưu ngày bắt đầu vào làm (startDate) và tính lương chuẩn theo ngày công thực tế (Chuyển đổi Lịch Âm -> Dương hoặc nhân viên mới vào giữa tháng)
const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Quản Lý Ngày Bắt Đầu Vào Làm (startDate) & Tính Lương Tỷ Lệ Theo Công', () => {
  let testUser;
  let testToken;
  let newEmployee;

  beforeAll(async () => {
    // 1. Khởi tạo tài khoản chủ buôn
    const userRes = await createTestUser('ChuBuon_EmpStartDate');
    testUser = userRes.user;
    testToken = userRes.token;

    // Cấp quyền quản lý nhân viên
    await prisma.user.update({
      where: { id: testUser.id },
      data: { canManageEmployees: true },
    });
  });

  afterAll(async () => {
    try {
      if (newEmployee) {
        await prisma.attendance.deleteMany({ where: { employeeId: newEmployee.id } });
        await prisma.salaryAdvance.deleteMany({ where: { employeeId: newEmployee.id } });
        await prisma.salaryPayment.deleteMany({ where: { employeeId: newEmployee.id } });
        await prisma.employee.deleteMany({ where: { id: newEmployee.id } });
      }
      if (testUser) {
        await cleanupTestUser(testUser.id);
      }
    } catch (e) {
      console.warn('Lỗi dọn dẹp test employeeStartDateSalary:', e.message);
    }
  });

  it('1. Tạo mới nhân viên vào làm giữa tháng (ví dụ: ngày 16/10/2026) với mức lương 31.000.000đ/tháng', async () => {
    const res = await request(app)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        name: 'NV_VaoGiuaThang',
        phone: '0977112233',
        role: 'Lọc thịt',
        baseSalary: 31000000,
        startDate: '2026-10-16',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.startDate).toContain('2026-10-16');
    newEmployee = res.body.data;
  });

  it('2. Lấy danh sách nhân viên tháng 10/2026 (31 ngày) -> Nhân viên chỉ được tính 16 ngày công (từ 16 đến 31)', async () => {
    const res = await request(app)
      .get('/api/v1/employees?monthKey=10/2026')
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const emp = res.body.data.find((e) => e.id === newEmployee.id);
    expect(emp).toBeDefined();
    expect(emp.totalDaysInMonth).toBe(31);
    expect(emp.eligibleDays).toBe(16); // 31 - 16 + 1 = 16 công
    expect(emp.joinedMidMonth).toBe(true);
    // 31.000.000 / 31 = 1.000.000/ngày * 16 = 16.000.000đ
    expect(emp.calculatedSalary).toBe(16000000);
    expect(emp.remainingSalary).toBe(16000000);
  });

  it('3. Khi xem tháng 09/2026 (trước khi vào làm) -> eligibleDays = 0, lương = 0', async () => {
    const res = await request(app)
      .get('/api/v1/employees?monthKey=09/2026')
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const emp = res.body.data.find((e) => e.id === newEmployee.id);
    expect(emp).toBeDefined();
    expect(emp.eligibleDays).toBe(0);
    expect(emp.calculatedSalary).toBe(0);
    expect(emp.remainingSalary).toBe(0);
  });

  it('4. Nhân viên xin nghỉ 1 ngày (ngày 20/10) và ứng 2.000.000đ -> Lương thực lĩnh trừ đúng', async () => {
    // Xin nghỉ ngày 20/10
    await request(app)
      .post('/api/v1/employees/leave')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        employeeId: newEmployee.id,
        date: '2026-10-20',
        shift: 'FULL',
        note: 'Nghỉ có việc riêng',
      });

    // Ứng lương 2.000.000đ
    const advRes = await request(app)
      .post('/api/v1/employees/advances')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        employeeId: newEmployee.id,
        amount: 2000000,
        date: '2026-10-22',
        note: 'Ứng tiền chi tiêu',
      });

    expect(advRes.status).toBe(201);

    const res = await request(app)
      .get('/api/v1/employees?monthKey=10/2026')
      .set('Authorization', `Bearer ${testToken}`);

    const emp = res.body.data.find((e) => e.id === newEmployee.id);
    expect(emp.workingDays).toBe(15); // 16 - 1 = 15 công
    expect(emp.calculatedSalary).toBe(15000000); // 15 công * 1.000.000đ
    expect(emp.totalAdvances).toBe(2000000);
    expect(emp.remainingSalary).toBe(13000000); // 15.000.000 - 2.000.000 = 13.000.000đ
  });

  it('5. Cập nhật ngày bắt đầu vào làm (startDate) qua API PUT /api/v1/employees/:id', async () => {
    // Đổi ngày vào làm sang ngày 21/10/2026 (chỉ còn 11 công: 21 đến 31)
    const updateRes = await request(app)
      .put(`/api/v1/employees/${newEmployee.id}`)
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        startDate: '2026-10-21',
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.startDate).toContain('2026-10-21');

    const res = await request(app)
      .get('/api/v1/employees?monthKey=10/2026')
      .set('Authorization', `Bearer ${testToken}`);

    const emp = res.body.data.find((e) => e.id === newEmployee.id);
    expect(emp.eligibleDays).toBe(11); // 31 - 21 + 1 = 11 công
    // Ngày nghỉ 20/10 trước ngày vào làm 21/10 nên không bị trừ công
    expect(emp.workingDays).toBe(11);
    expect(emp.calculatedSalary).toBe(11000000);
  });

  it('6. Kiểm tra dữ liệu lũy kế đến ngày hiện tại (currentWorkingDays, currentSalary, currentDayCutoff)', async () => {
    const res = await request(app)
      .get('/api/v1/employees?monthKey=10/2026')
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    const emp = res.body.data.find((e) => e.id === newEmployee.id);
    expect(emp).toBeDefined();
    expect(typeof emp.currentDayCutoff).toBe('number');
    expect(typeof emp.currentWorkingDays).toBe('number');
    expect(typeof emp.currentSalary).toBe('number');
    expect(typeof emp.currentRemainingSalary).toBe('number');
    expect(emp.currentSalary).toBeGreaterThanOrEqual(0);
  });
});

