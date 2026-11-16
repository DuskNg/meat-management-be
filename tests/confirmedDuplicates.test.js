// Kiểm thử tự động: Đồng bộ danh sách đơn trùng đã xác nhận ("Bằng cân nhưng đúng") liên thiết bị
const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Đồng Bộ Xác Nhận Đơn Trùng Liên Thiết Bị', () => {
  let testUser;
  let testToken;

  beforeAll(async () => {
    const userRes = await createTestUser('[TEST]_ConfirmedDupUser');
    testUser = userRes.user;
    testToken = userRes.token;
  });

  afterAll(async () => {
    if (testUser?.id) {
      await prisma.confirmedDuplicateKey.deleteMany({ where: { userId: testUser.id } });
    }
    await cleanupTestUser(testUser?.id);
  });

  it('1. Lưu và lấy lại danh sách key đơn trùng đã xác nhận (hỗ trợ chống trùng lặp khi gửi lại)', async () => {
    // Arrange
    const sampleKeys = [
      'dup_cust1_16/11/2026_tai (bo)_1.50_1.50',
      'dup_cust1_16/11/2026_sung_1.50_2.00',
    ];

    // Act 1: Gửi lưu danh sách key lên server (kèm 1 key trùng để kiểm tra skipDuplicates)
    const saveRes = await request(app)
      .post('/api/v1/transactions/confirmed-duplicates')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ keys: [...sampleKeys, sampleKeys[0], '   '] });

    // Assert 1
    expect(saveRes.status).toBe(200);
    expect(saveRes.body.success).toBe(true);
    expect(saveRes.body.data).toEqual(sampleKeys);

    // Act 2: Thiết bị khác gọi GET để tải lại danh sách key đã xác nhận
    const getRes = await request(app)
      .get('/api/v1/transactions/confirmed-duplicates')
      .set('Authorization', `Bearer ${testToken}`);

    // Assert 2
    expect(getRes.status).toBe(200);
    expect(getRes.body.success).toBe(true);
    expect(new Set(getRes.body.data)).toEqual(new Set(sampleKeys));

    // Assert DB
    const dbCount = await prisma.confirmedDuplicateKey.count({ where: { userId: testUser.id } });
    expect(dbCount).toBe(2);
  });

  it('2. Từ chối nếu payload keys không phải là mảng', async () => {
    const res = await request(app)
      .post('/api/v1/transactions/confirmed-duplicates')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ keys: 'invalid' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
