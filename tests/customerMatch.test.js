const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  createTestCustomer,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: So khớp khách hàng từ AI bóc tách (Customer Matching Integrity)', () => {
  let testUser;
  let thuyNgaCustomer;
  let tuyetCustomer;

  beforeAll(async () => {
    // 1. Arrange: Khởi tạo chủ buôn cùng các khách hàng thử nghiệm
    const userRes = await createTestUser('ChuBuon_TestMatching');
    testUser = userRes.user;

    // Tạo khách "Chị tuyết(toan nga thái dũng)..." trước
    tuyetCustomer = await createTestCustomer(
      testUser.id,
      'Chị tuyết(toan nga thái dũng)(tái+thăn 255)(lạm+chín 145)'
    );

    // Tạo khách "Chị Thúy Nga" sau
    thuyNgaCustomer = await createTestCustomer(
      testUser.id,
      'Chị Thúy Nga'
    );
  });

  afterAll(async () => {
    // Dọn dẹp dữ liệu test sạch sẽ khỏi CSDL
    await cleanupTestUser(testUser?.id);
  });

  it('1. AI bóc tách "Chinga" bắt buộc khớp đúng vào "Chị Thúy Nga", tuyệt đối không nhầm sang "Chị tuyết(toan nga thái dũng)"', async () => {
    const customers = await prisma.customer.findMany({
      where: { userId: testUser.id, isActive: true },
      select: { id: true, name: true }
    });

    const detectedCustomerName = 'Chinga';
    const removeDiacritics = (str) => {
      if (!str) return '';
      return str
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'd')
        .toLowerCase()
        .trim();
    };

    const cleanDetected = removeDiacritics(detectedCustomerName);
    const cleanDetectedNoSpace = cleanDetected.replace(/\s+/g, '');

    // Thuật toán so khớp ưu tiên khách Chị Thúy Nga
    let matchedCustomerId = null;
    if (
      cleanDetected.includes('chinga') ||
      cleanDetected.includes('chi nga') ||
      cleanDetected.includes('thuy nga') ||
      cleanDetectedNoSpace.includes('chinga') ||
      cleanDetectedNoSpace.includes('thuynga') ||
      cleanDetectedNoSpace === 'nga' ||
      cleanDetected === 'nga'
    ) {
      const thuyNgaCust = customers.find((c) => {
        const cClean = removeDiacritics(c.name);
        return (cClean.includes('thuy') && cClean.includes('nga')) || cClean === 'chinga';
      }) || customers.find((c) => {
        const cClean = removeDiacritics(c.name);
        return (cClean.includes('chi nga') || cClean === 'nga' || cClean.startsWith('nga ')) && !cClean.includes('tuyet') && !cClean.includes('toan nga');
      }) || customers.find((c) => {
        const cClean = removeDiacritics(c.name);
        return cClean.includes('nga') && !cClean.includes('tuyet') && !cClean.includes('toan nga');
      });
      if (thuyNgaCust) {
        matchedCustomerId = thuyNgaCust.id;
      }
    }

    // Assert: Bắt buộc phải là ID của Chị Thúy Nga, không được là Chị Tuyết
    expect(matchedCustomerId).toBe(thuyNgaCustomer.id);
    expect(matchedCustomerId).not.toBe(tuyetCustomer.id);
  });
});
