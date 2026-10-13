// Kiểm thử tự động: Lọc chính xác theo từng ngày cho hóa đơn nhân viên gửi (Staff Submission Date Filter)
const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Lọc Hóa Đơn Nhân Viên Theo Ngày (Staff Submission Date Filter)', () => {
  let testUser;
  let testToken;
  let subDay1;
  let subDay2;

  beforeAll(async () => {
    // 1. Arrange: Khởi tạo chủ buôn mẫu
    const userRes = await createTestUser('ChuBuon_FilterSub');
    testUser = userRes.user;
    testToken = userRes.token;

    // Tạo link nhân viên mẫu
    const link = await prisma.staffSubmissionLink.create({
      data: {
        userId: testUser.id,
        name: 'Nhóm Giao Hàng Test',
        token: `test_token_${Date.now()}`,
      },
    });

    // Tạo 2 đơn chưa duyệt: 1 đơn ngày 2026-10-12 và 1 đơn ngày 2026-10-13
    subDay1 = await prisma.staffSubmission.create({
      data: {
        userId: testUser.id,
        linkId: link.id,
        senderName: 'NV Nam Ngày 12',
        fileUrl: '/uploads/test_12.jpg',
        fileType: 'IMAGE',
        date: new Date('2026-10-12T08:30:00+07:00'),
        status: 'READY_FOR_REVIEW',
      },
    });

    subDay2 = await prisma.staffSubmission.create({
      data: {
        userId: testUser.id,
        linkId: link.id,
        senderName: 'NV An Ngày 13',
        fileUrl: '/uploads/test_13.jpg',
        fileType: 'IMAGE',
        date: new Date('2026-10-13T09:15:00+07:00'),
        status: 'READY_FOR_REVIEW',
      },
    });
  });

  afterAll(async () => {
    // Teardown: Dọn dẹp sạch sẽ dữ liệu phát sinh
    if (testUser?.id) {
      await prisma.staffSubmission.deleteMany({ where: { userId: testUser.id } });
      await prisma.staffSubmissionLink.deleteMany({ where: { userId: testUser.id } });
      await cleanupTestUser(testUser.id);
    }
  });

  it('1. Khi lọc ngày 13/10/2026: Chỉ hiển thị các đơn chưa duyệt của ngày 13, không bị dồn đơn của ngày 12', async () => {
    // Act
    const res = await request(app)
      .get('/api/v1/staff-submissions?date=2026-10-13')
      .set('Authorization', `Bearer ${testToken}`);

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data = res.body.data || [];
    const hasDay2 = data.some((s) => s.id === subDay2.id);
    const hasDay1 = data.some((s) => s.id === subDay1.id);

    expect(hasDay2).toBe(true);
    expect(hasDay1).toBe(false);
  });

  it('2. Khi lọc ngày 12/10/2026: Chỉ hiển thị các đơn chưa duyệt của ngày 12, không bị lẫn đơn của ngày 13', async () => {
    // Act
    const res = await request(app)
      .get('/api/v1/staff-submissions?date=2026-10-12')
      .set('Authorization', `Bearer ${testToken}`);

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data = res.body.data || [];
    const hasDay1 = data.some((s) => s.id === subDay1.id);
    const hasDay2 = data.some((s) => s.id === subDay2.id);

    expect(hasDay1).toBe(true);
    expect(hasDay2).toBe(false);
  });

  it('3. Khi không lọc ngày (xem Tổng các đơn): Hiển thị đầy đủ cả 2 đơn của cả 2 ngày', async () => {
    // Act
    const res = await request(app)
      .get('/api/v1/staff-submissions')
      .set('Authorization', `Bearer ${testToken}`);

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data = res.body.data || [];
    const hasDay1 = data.some((s) => s.id === subDay1.id);
    const hasDay2 = data.some((s) => s.id === subDay2.id);

    expect(hasDay1).toBe(true);
    expect(hasDay2).toBe(true);
  });
});
