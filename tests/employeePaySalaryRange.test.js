// meat-management-be/tests/employeePaySalaryRange.test.js
// Kiểm thử tự động: Xem trước và chi trả lương nhân viên theo khoảng ngày linh hoạt
const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Xem Trước & Chi Trả Lương Theo Khoảng Ngày (Pay Salary by Date Range)', () => {
  let testUser;
  let testToken;
  let testEmployee;

  beforeAll(async () => {
    const userRes = await createTestUser('ChuBuon_SalaryRange');
    testUser = userRes.user;
    testToken = userRes.token;

    await prisma.user.update({
      where: { id: testUser.id },
      data: { canManageEmployees: true },
    });

    // Tạo nhân viên thử nghiệm: Lương 31.000.000đ/tháng (~1.000.000đ/ngày trong tháng 10)
    const empRes = await request(app)
      .post('/api/v1/employees')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        name: 'NV_TestTraLuongKhoangNgay',
        phone: '0988776655',
        role: 'Bán thịt',
        baseSalary: 31000000,
        startDate: '2026-10-01',
      });

    testEmployee = empRes.body.data;

    // Nhân viên ứng 1.000.000đ vào ngày 05/10
    await request(app)
      .post('/api/v1/employees/advances')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        employeeId: testEmployee.id,
        amount: 1000000,
        date: '2026-10-05',
        note: 'Ứng tiền đợt 1',
      });

    // Nhân viên xin nghỉ 1 ngày vào ngày 08/10
    await request(app)
      .post('/api/v1/employees/leave')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        employeeId: testEmployee.id,
        date: '2026-10-08',
        shift: 'FULL',
        note: 'Nghỉ đám cưới',
      });
  });

  afterAll(async () => {
    try {
      if (testEmployee) {
        await prisma.attendance.deleteMany({ where: { employeeId: testEmployee.id } });
        await prisma.salaryAdvance.deleteMany({ where: { employeeId: testEmployee.id } });
        await prisma.salaryPayment.deleteMany({ where: { employeeId: testEmployee.id } });
        await prisma.employee.deleteMany({ where: { id: testEmployee.id } });
      }
      if (testUser) {
        await cleanupTestUser(testUser.id);
      }
    } catch (e) {
      console.warn('Lỗi dọn dẹp test employeePaySalaryRange:', e.message);
    }
  });

  it('1. GET /api/v1/employees/salary/preview: Xem trước chi tiết tính lương từ ngày 01/10/2026 đến 15/10/2026', async () => {
    const res = await request(app)
      .get(`/api/v1/employees/salary/preview?employeeId=${testEmployee.id}&fromDate=2026-10-01&toDate=2026-10-15`)
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(data.eligibleDays).toBe(15);
    expect(data.leaveDays).toBe(1);
    expect(data.workingDays).toBe(14); // 15 - 1 = 14 công
    // 31.000.000 / 31 = 1.000.000đ/công * 14 = 14.000.000đ
    expect(data.calculatedSalary).toBe(14000000);
    expect(data.totalAdvances).toBe(1000000);
    expect(data.suggestedFinalAmount).toBe(13000000); // 14.000.000 - 1.000.000 = 13.000.000đ
    expect(data.isOverlapped).toBe(false);
  });

  it('2. POST /api/v1/employees/salary/pay: Thanh toán lương đợt 1 (01/10/2026 - 15/10/2026)', async () => {
    const res = await request(app)
      .post('/api/v1/employees/salary/pay')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        employeeId: testEmployee.id,
        fromDate: '2026-10-01',
        toDate: '2026-10-15',
        monthKey: '10/2026',
        bonus: 500000, // Thưởng thêm 500k
        deductions: 0,
        note: 'Chi trả đợt 1',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const payment = res.body.data;
    expect(payment.id).toBeDefined();
    // 14.000.000 - 1.000.000 + 500.000 = 13.500.000đ
    expect(parseFloat(payment.finalAmount)).toBe(13500000);
    expect(payment.fromDate).toBeDefined();
    expect(payment.toDate).toBeDefined();
  });

  it('3. Thử thanh toán khoảng ngày bị trùng lặp (10/10/2026 - 20/10/2026) -> Báo lỗi trùng lặp đợt chi trả', async () => {
    const res = await request(app)
      .post('/api/v1/employees/salary/pay')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        employeeId: testEmployee.id,
        fromDate: '2026-10-10',
        toDate: '2026-10-20',
        monthKey: '10/2026',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('trùng lặp');
  });

  it('4. Thanh toán đợt 2 (16/10/2026 - 31/10/2026) -> Thành công trong cùng tháng', async () => {
    const res = await request(app)
      .post('/api/v1/employees/salary/pay')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        employeeId: testEmployee.id,
        fromDate: '2026-10-16',
        toDate: '2026-10-31',
        monthKey: '10/2026',
        note: 'Chi trả đợt 2 cuối tháng',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const payment = res.body.data;
    // Từ 16 đến 31 là 16 công, không nghỉ, không ứng -> 16.000.000đ
    expect(parseFloat(payment.finalAmount)).toBe(16000000);
  });

  it('5. POST /api/v1/employees/salary/pay kèm amount tùy chỉnh: Hệ thống lưu đúng số tiền người dùng chỉ định', async () => {
    // Tạo thêm nhân viên test thứ 2 để thử nghiệm thanh toán với số tiền tùy chỉnh
    const emp2 = await prisma.employee.create({
      data: {
        userId: testUser.id,
        name: 'NV_TestAmountCustom',
        role: 'Giao hàng',
        baseSalary: 15000000,
        startDate: new Date('2026-11-01'),
        isActive: true,
      },
    });

    const res = await request(app)
      .post('/api/v1/employees/salary/pay')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        employeeId: emp2.id,
        fromDate: '2026-11-01',
        toDate: '2026-11-15',
        monthKey: '11/2026',
        amount: 8500000, // Người dùng tự nhập 8.500.000đ
        note: 'Trả lương tùy chỉnh 8.500.000đ',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const payment = res.body.data;
    expect(parseFloat(payment.finalAmount)).toBe(8500000);

    // Dọn dẹp nhân viên test 2
    await prisma.salaryPayment.deleteMany({ where: { employeeId: emp2.id } });
    await prisma.employee.delete({ where: { id: emp2.id } });
  });

  it('6. Khi trả lương 1 phần: GET /api/v1/employees trừ chính xác số tiền đã trả vào remainingSalary, đánh dấu isPartiallyPaid = true', async () => {
    // Tạo nhân viên test 3: Lương 30.000.000đ, đã trả đợt 1 là 10.000.000đ
    const emp3 = await prisma.employee.create({
      data: {
        userId: testUser.id,
        name: 'NV_TestTraLuongMotPhan',
        role: 'Lọc thịt',
        baseSalary: 30000000,
        startDate: new Date('2026-10-01'),
        isActive: true,
      },
    });

    // Trả lương 1 phần: 10.000.000đ
    await request(app)
      .post('/api/v1/employees/salary/pay')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        employeeId: emp3.id,
        fromDate: '2026-10-01',
        toDate: '2026-10-10',
        monthKey: '10/2026',
        amount: 10000000,
        note: 'Trả đợt 1',
      });

    // Gọi API lấy danh sách nhân viên tháng 10/2026
    const res = await request(app)
      .get('/api/v1/employees?monthKey=10/2026')
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    const empData = res.body.data.find((e) => e.id === emp3.id);
    expect(empData).toBeDefined();
    expect(empData.totalPaidSalary).toBe(10000000);
    // Tổng lương 30.000.000đ - Đã trả 10.000.000đ = Còn lại 20.000.000đ
    expect(empData.remainingSalary).toBe(20000000);
    // Vì mới trả 1 phần nên isPartiallyPaid = true, isPaid = false
    expect(empData.isPartiallyPaid).toBe(true);
    expect(empData.isPaid).toBe(false);

    // Dọn dẹp nhân viên test 3
    await prisma.salaryPayment.deleteMany({ where: { employeeId: emp3.id } });
    await prisma.employee.delete({ where: { id: emp3.id } });
  });
});

