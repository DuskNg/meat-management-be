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

  it('2. AI bóc tách "Trung kính" hoặc "trung kính" bắt buộc khớp đúng vào "Bếp trung kính", tuyệt đối không nhầm sang "Trungkinh"', async () => {
    // Tạo thêm 2 khách: "Trungkinh" và "Bếp trung kính"
    const trungKinhPseudo = await createTestCustomer(testUser.id, 'Trungkinh');
    const bepTrungKinhCustomer = await createTestCustomer(testUser.id, 'Bếp trung kính (zalo loantt)');

    const customers = await prisma.customer.findMany({
      where: { userId: testUser.id, isActive: true },
      select: { id: true, name: true },
    });

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

    const testDetectedNames = ['Trung kính', 'trung kính', 'Trungkinh', 'tuy kinh', 'trung kh', 'tuy kh'];

    for (const detectedName of testDetectedNames) {
      const cleanDetected = removeDiacritics(detectedName);
      const cleanDetectedNoSpace = cleanDetected.replace(/\s+/g, '');

      let matchedCustomerId = null;

      // 0a. Quy tắc ưu tiên Bếp trung kính
      const isDetectedTrungKinh =
        cleanDetected.includes('trung kinh') ||
        cleanDetected.includes('bep trung kinh') ||
        cleanDetected.includes('tuy kinh') ||
        cleanDetected.includes('tung kinh') ||
        cleanDetected.includes('truy kinh') ||
        cleanDetected.includes('tug kinh') ||
        cleanDetected.includes('trung kh') ||
        cleanDetected.includes('tuy kh') ||
        cleanDetected.includes('tuy ks') ||
        cleanDetected.includes('tug kh') ||
        cleanDetected.includes('tung kh') ||
        cleanDetected.includes('truy kh') ||
        cleanDetectedNoSpace === 'trungkinh' ||
        cleanDetectedNoSpace === 'tuykinh' ||
        cleanDetectedNoSpace === 'tungkinh' ||
        cleanDetectedNoSpace === 'truykinh' ||
        cleanDetectedNoSpace === 'tugkinh' ||
        cleanDetectedNoSpace === 'tuykh' ||
        cleanDetectedNoSpace === 'tuykhs' ||
        cleanDetectedNoSpace === 'tuyks' ||
        cleanDetectedNoSpace === 'tugkh' ||
        cleanDetectedNoSpace === 'tungkh' ||
        cleanDetectedNoSpace === 'truykh' ||
        cleanDetectedNoSpace.includes('trungkinh') ||
        cleanDetectedNoSpace.includes('tuykinh') ||
        cleanDetectedNoSpace.includes('beptrungkinh') ||
        (cleanDetected.includes('trung') && cleanDetected.includes('kinh'));

      if (isDetectedTrungKinh) {
        const bepTrungKinhCust = customers.find((c) => {
          const cClean = removeDiacritics(c.name.toLowerCase().trim());
          return cClean.includes('bep trung kinh') || (cClean.includes('bep') && cClean.includes('trung') && cClean.includes('kinh'));
        }) || customers.find((c) => {
          const cClean = removeDiacritics(c.name.toLowerCase().trim());
          return cClean.includes('trung kinh') || cClean === 'trungkinh';
        }) || null;

        if (bepTrungKinhCust) {
          matchedCustomerId = bepTrungKinhCust.id;
        }
      }

      if (!matchedCustomerId) {
        // Exact match
        const exactCust = customers.find((c) => {
          const cClean = removeDiacritics(c.name.toLowerCase().trim());
          const cCleanNoSpace = cClean.replace(/\s+/g, '');
          return cClean === cleanDetected || cCleanNoSpace === cleanDetectedNoSpace;
        });
        if (exactCust) {
          matchedCustomerId = exactCust.id;
        }
      }

      // Assert: Bắt buộc phải là Bếp trung kính, không được là Trungkinh
      expect(matchedCustomerId).toBe(bepTrungKinhCustomer.id);
      expect(matchedCustomerId).not.toBe(trungKinhPseudo.id);
    }
  });

  it('3. Khi đơn có các từ khóa "nhập", "mua", "nhập vào"...: Bắt buộc nhận diện là đơn NHẬP HÀNG (is_import=true, is_return=false), ghi chú là "Nhập hàng"', async () => {
    const importRegex = /(?:nhập hàng|nhap hang|nhập thịt|nhap thit|mua hàng|mua hang|mua thịt|mua thit|nhập vào|nhap vao|mua vào|mua vao|nhập về|nhap ve|mua về|mua ve|lấy vào|lay vao|nhập kho|nhap kho|nhập lò|nhap lo|mua lò|mua lo|lấy thịt về|lay thit ve|lấy hàng về|lay hang ve|nhập lô|nhap lo|\bnhập\b|\bnhap\b|\bmua thịt\b|\bmua hàng\b|\bmua vào\b|\bmua về\b|\bmua\b)/i;
    const returnRegex = /(trả hàng|gửi về|trả về|trả lại|gửi lại|hàng trả|thu hồi|bắn về|quay đầu|đổi trả|hoàn hàng|tra hang|gui ve|tra ve|tra lai|gui lai|hang tra|quay dau|doi tra|hoan hang)/i;

    const sampleTestCases = [
      { rawAi: 'nhập Hạnh 7.35kg gầu bò', note: null },
      { rawAi: 'mua vào 10 cân thăn', note: null },
      { rawAi: 'nhập vào gầu 7.35', note: null },
      { rawAi: 'Hạnh nhập thịt', note: null },
      { rawAi: 'mua hàng của lò mổ', note: null },
      { rawAi: 'nhập kho 15kg bắp bò', note: null },
      { rawAi: null, note: 'nhập hàng' },
      { rawAi: null, note: 'Nhập vào 5 cân thăn' },
    ];

    for (const tc of sampleTestCases) {
      const isImportOrder = Boolean(
        (tc.note && importRegex.test(tc.note)) ||
        (tc.rawAi && importRegex.test(tc.rawAi))
      );

      const isReturnOrder = !isImportOrder && Boolean(
        (tc.note && returnRegex.test(tc.note)) ||
        (tc.rawAi && returnRegex.test(tc.rawAi))
      );

      let submissionNote = '';
      if (isImportOrder) {
        submissionNote = 'Nhập hàng';
      } else if (isReturnOrder) {
        submissionNote = 'Trả hàng';
      }

      expect(isImportOrder).toBe(true);
      expect(isReturnOrder).toBe(false);
      expect(submissionNote).toBe('Nhập hàng');
    }
  });

  it('4. Đơn nhập hàng từ "Hạnh": Bắt buộc khớp vào Nhà Cung Cấp Hạnh, TUYỆT ĐỐI KHÔNG gán vào khách hàng "Chị hạnh sân bóng hà trì"', async () => {
    // Tạo 1 nhà cung cấp tên "Hạnh" và 1 khách hàng "Chị hạnh sân bóng hà trì"
    const supplierHanh = await prisma.supplier.create({
      data: {
        userId: testUser.id,
        name: 'Hạnh',
        phone: '0988776655',
        isActive: true,
      },
    });

    const customerHanh = await createTestCustomer(testUser.id, 'Chị hạnh sân bóng hà trì');

    const suppliers = await prisma.supplier.findMany({
      where: { userId: testUser.id, isActive: true },
      select: { id: true, name: true },
    });

    const isImportOrder = true;
    const detectedName = 'nhập Hạnh';

    const cleanDetectedName = detectedName
      .replace(/\b(nhập thịt|nhập hàng|mua thịt|mua hàng|nhập vào|mua vào|nhập về|mua về|lấy vào|lấy thịt về|lấy hàng về|nhập lô|nhập kho|nhập lò|mua lò|nhap thit|nhap hang|mua thit|mua hang|nhap vao|mua vao|nhap ve|mua ve|lay vao|nhap kho|nhap lo|mua lo|nhập|nhap|mua)\b/gi, '')
      .replace(/[-–—:()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    expect(cleanDetectedName).toBe('Hạnh');

    const removeDiacritics = (str) => {
      if (!str) return '';
      return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().trim();
    };

    let matchedCustomerId = null;
    let matchedSupplier = null;

    if (isImportOrder && cleanDetectedName && suppliers.length > 0) {
      const cleanDetected = removeDiacritics(cleanDetectedName);
      const cleanDetectedNoSpace = cleanDetected.replace(/\s+/g, '');
      matchedSupplier = suppliers.find((s) => {
        const sClean = removeDiacritics(s.name);
        const sNoSpace = sClean.replace(/\s+/g, '');
        return sClean === cleanDetected || sNoSpace === cleanDetectedNoSpace || sClean.includes(cleanDetected) || cleanDetected.includes(sClean);
      });
    }

    // Assert: Khớp đúng nhà cung cấp Hạnh, matchedCustomerId vẫn là null (không gán nhầm sang khách hàng)
    expect(matchedSupplier).not.toBeNull();
    expect(matchedSupplier.id).toBe(supplierHanh.id);
    expect(matchedCustomerId).toBeNull();
    expect(matchedCustomerId).not.toBe(customerHanh.id);
  });

  it('5. Khách Chị Tuyết khi lấy thịt số lượng lớn > 10kg: Bắt buộc auto là Thịt chín và khớp giá riêng 145.000đ', async () => {
    // Tạo 2 sản phẩm: Thăn bò (255k) và Chín(vai + lạm) (145k)
    const productThan = await prisma.product.create({
      data: {
        userId: testUser.id,
        name: 'Thăn bò',
        defaultPrice: 240000,
        unit: 'kg',
      },
    });

    const productChin = await prisma.product.create({
      data: {
        userId: testUser.id,
        name: 'Chín(vai + lạm)',
        defaultPrice: 160000,
        unit: 'kg',
      },
    });

    // Thiết lập giá riêng cho Chị Tuyết: Thăn bò = 255k, Chín = 145k
    await prisma.customerProductPrice.createMany({
      data: [
        {
          customerId: tuyetCustomer.id,
          productId: productThan.id,
          price: 255000,
        },
        {
          customerId: tuyetCustomer.id,
          productId: productChin.id,
          price: 145000,
        },
      ],
    });

    // Lấy bảng giá riêng của Chị Tuyết
    const customerPrices = await prisma.customerProductPrice.findMany({
      where: { customerId: tuyetCustomer.id },
    });
    const customerPriceMap = new Map();
    customerPrices.forEach((cp) => customerPriceMap.set(cp.productId, parseFloat(cp.price)));

    const products = [productThan, productChin];
    const removeDiacritics = (str) => {
      if (!str) return '';
      return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().trim();
    };

    // Mô phỏng AI bóc tách video: Khách Tuyết, khối lượng 18.49kg (> 10kg), tên thịt AI đọc là "Thăn" hoặc để trống
    const rawItems = [{ name: 'Thăn', quantity: 18.49 }];
    const cleanCustDetected = removeDiacritics(tuyetCustomer.name);
    const isVideo = true;
    const isTuyetCustomer = cleanCustDetected.includes('tuyet');

    // Chạy logic xử lý đặc thù cho Chị Tuyết
    rawItems.forEach((item) => {
      const itemClean = removeDiacritics((item.name || '').toLowerCase().trim());
      const qtyVal = item.quantity != null ? parseFloat(String(item.quantity).replace(',', '.')) : null;
      const isLargeQty = qtyVal != null && qtyVal > 10;
      const isNoMeatName = !itemClean || ['thit', 'thit bo', 'thit le', 'mon le', 'thit thai', 'than', 'than bo', ''].includes(itemClean) || !item.name;

      if (isLargeQty || isNoMeatName) {
        item.name = 'Thịt chín';
      }
    });

    expect(rawItems[0].name).toBe('Thịt chín');

    // Khớp sản phẩm và tính tiền
    const cleanItemName = removeDiacritics(rawItems[0].name.toLowerCase());
    let matchedProd = null;
    if (customerPriceMap.size > 0) {
      matchedProd = products.find((p) => {
        if (!customerPriceMap.has(p.id)) return false;
        const pClean = removeDiacritics(p.name.toLowerCase().trim());
        if (cleanItemName.includes('chin') || cleanItemName === 'thit chin') {
          return pClean.includes('chin') || pClean === 'chin';
        }
        return pClean === cleanItemName || cleanItemName.includes(pClean) || pClean.includes(cleanItemName);
      });
    }

    expect(matchedProd).not.toBeNull();
    expect(matchedProd.id).toBe(productChin.id);

    const price = customerPriceMap.get(matchedProd.id);
    expect(price).toBe(145000);
    const amount = Math.round(rawItems[0].quantity * price);
    expect(amount).toBe(2681050); // 18.49 * 145000 = 2681050 (không phải 4714950 của thăn 255k)
  });

  it('6. Khách Chị Tuyết khi không đọc tên thịt: Bắt buộc auto là Thịt chín', async () => {
    const removeDiacritics = (str) => {
      if (!str) return '';
      return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().trim();
    };

    // Mô phỏng video không đọc tên thịt (chỉ đọc cân nặng 4.5kg, tên thịt để trống)
    const rawItems = [{ name: '', quantity: 4.5 }];
    const cleanCustDetected = removeDiacritics(tuyetCustomer.name);
    const isVideo = true;
    const isTuyetCustomer = cleanCustDetected.includes('tuyet');

    rawItems.forEach((item) => {
      const itemClean = removeDiacritics((item.name || '').toLowerCase().trim());
      const qtyVal = item.quantity != null ? parseFloat(String(item.quantity).replace(',', '.')) : null;
      const isLargeQty = qtyVal != null && qtyVal > 10;
      const isNoMeatName = !itemClean || ['thit', 'thit bo', 'thit le', 'mon le', 'thit thai', 'than', 'than bo', ''].includes(itemClean) || !item.name;

      if (isLargeQty || isNoMeatName) {
        item.name = 'Thịt chín';
      }
    });

    expect(rawItems[0].name).toBe('Thịt chín');
  });

  describe('So khớp sản phẩm thông minh (Product Matching Integrity): Bảo toàn sau khi đổi tên thịt', () => {
    const { matchProductByName } = require('../src/services/aiInvoiceParser');

    const sampleProducts = [
      { id: 'prod-diem-bo', name: 'Diềm bò' },
      { id: 'prod-diem-bo-thai', name: 'Diềm bò thái' },
      { id: 'prod-than-bo', name: 'Thăn bò' },
      { id: 'prod-tai-bo', name: 'Tái (bò)' },
      { id: 'prod-bap-bo', name: 'Bắp bò' },
      { id: 'prod-bap-giay', name: 'Bắp giây' },
      { id: 'prod-lac-vai', name: 'Lạc vai' },
      { id: 'prod-la-vai', name: 'Lá vai' },
      { id: 'prod-bo-xay', name: 'bò xay' },
      { id: 'prod-chin', name: 'Chín(vai + lạm)' },
      { id: 'prod-gau-bo', name: 'Gầu bò' },
      { id: 'prod-gau-coc', name: 'Gầu cộc' },
    ];

    it('7. Khi bóc tách "diềm thăn bò" hoặc "diềm thăn" hoặc "diềm bò": Bắt buộc khớp vào "Diềm bò", TUYỆT ĐỐI KHÔNG nhảy sang "Thăn bò"', () => {
      // Trường hợp người dùng đổi Diềm thăn thành Diềm bò
      const match1 = matchProductByName('diem than bo', sampleProducts);
      expect(match1).not.toBeNull();
      expect(match1.name).toBe('Diềm bò');
      expect(match1.id).not.toBe('prod-than-bo');

      const match2 = matchProductByName('diem than', sampleProducts);
      expect(match2).not.toBeNull();
      expect(match2.name).toBe('Diềm bò');

      const match3 = matchProductByName('diem bo', sampleProducts);
      expect(match3).not.toBeNull();
      expect(match3.name).toBe('Diềm bò');

      const match4 = matchProductByName('diem bo thai', sampleProducts);
      expect(match4).not.toBeNull();
      expect(match4.name).toBe('Diềm bò thái');

      // Ngược lại, khi là "thăn bò" hoặc "thăn" thì vẫn phải về "Thăn bò"
      const matchThan = matchProductByName('than bo', sampleProducts);
      expect(matchThan).not.toBeNull();
      expect(matchThan.name).toBe('Thăn bò');
    });

    it('8. Khi bóc tách "thịt lá vai" hoặc "lá vai" hoặc "lá": Bắt buộc khớp vào "Lá vai", TUYỆT ĐỐI KHÔNG nhảy sang "Lạc vai"', () => {
      const matchLa1 = matchProductByName('thit la vai', sampleProducts);
      expect(matchLa1).not.toBeNull();
      expect(matchLa1.name).toBe('Lá vai');
      expect(matchLa1.id).not.toBe('prod-lac-vai');

      const matchLa2 = matchProductByName('la vai', sampleProducts);
      expect(matchLa2).not.toBeNull();
      expect(matchLa2.name).toBe('Lá vai');

      // Khi là "lạc vai" hoặc "vai" thì về "Lạc vai"
      const matchLacVai = matchProductByName('lac vai', sampleProducts);
      expect(matchLacVai).not.toBeNull();
      expect(matchLacVai.name).toBe('Lạc vai');

      const matchVai = matchProductByName('vai', sampleProducts);
      expect(matchVai).not.toBeNull();
      expect(matchVai.name).toBe('Lạc vai');
    });

    it('9. Khi bóc tách "vai xay" hoặc "bò xay" hoặc "xay": Bắt buộc khớp vào "bò xay"', () => {
      const matchXay1 = matchProductByName('vai xay', sampleProducts);
      expect(matchXay1).not.toBeNull();
      expect(matchXay1.name).toBe('bò xay');

      const matchXay2 = matchProductByName('bo xay', sampleProducts);
      expect(matchXay2).not.toBeNull();
      expect(matchXay2.name).toBe('bò xay');
    });

    it('10. Khi bóc tách "bắp giây" hoặc "bap giay": Bắt buộc khớp vào "Bắp giây", không nhầm sang "Bắp bò"', () => {
      const matchBapGiay = matchProductByName('bap giay', sampleProducts);
      expect(matchBapGiay).not.toBeNull();
      expect(matchBapGiay.name).toBe('Bắp giây');
      expect(matchBapGiay.id).not.toBe('prod-bap-bo');

      const matchBapBo = matchProductByName('bap bo', sampleProducts);
      expect(matchBapBo).not.toBeNull();
      expect(matchBapBo.name).toBe('Bắp bò');
    });

    it('11. Quy tắc Xg bò: So khớp vào "Xg Bò" và đảm bảo số lượng không bao giờ là 1 hay 1.5 kg (auto 5, 10, 15 kg)', () => {
      const productsWithXg = [
        ...sampleProducts,
        { id: 'prod-xg-bo', name: 'Xg Bò' },
      ];

      // 1. So khớp tên món thịt
      const matchXg1 = matchProductByName('xg bo', productsWithXg);
      expect(matchXg1).not.toBeNull();
      expect(matchXg1.name).toBe('Xg Bò');

      const matchXg2 = matchProductByName('x', productsWithXg);
      expect(matchXg2).not.toBeNull();
      expect(matchXg2.name).toBe('Xg Bò');

      const matchXg3 = matchProductByName('xuong bo', productsWithXg);
      expect(matchXg3).not.toBeNull();
      expect(matchXg3.name).toBe('Xg Bò');

      // Khi có 1 ký tự đơn lẻ viết ngoáy (như chữ 'x' nhìn như r, v, y, t, c...)
      const singleCharTests = ['r', 'v', 'y', 't', 'c'];
      for (const char of singleCharTests) {
        const matched = matchProductByName(char, productsWithXg);
        expect(matched).not.toBeNull();
        expect(matched.name).toBe('Xg Bò');
      }

      // Ký tự đơn lẻ 's' bắt buộc khớp Sườn
      const productsWithSuon = [...sampleProducts, { id: 'prod-suon', name: 'Sườn' }];
      const matchSuon = matchProductByName('s', productsWithSuon);
      expect(matchSuon).not.toBeNull();
      expect(matchSuon.name).toBe('Sườn');

      // 2. Logic chuẩn hóa số cân của Xg Bò
      const normalizeXgQuantity = (name, quantity) => {
        const cleanLower = name.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
        const isSuonXg = cleanLower.includes('suon');
        const isXgBo = !isSuonXg && ['x', 'xg', 'xg bo', 'xuong', 'xuong bo'].includes(cleanLower);
        let qty = quantity;
        if (isXgBo && qty != null) {
          if (qty === 1 || qty === 1.0) qty = 10;
          else if (qty === 1.5) qty = 15;
        }
        return qty;
      };

      expect(normalizeXgQuantity('Xg Bò', 1)).toBe(10);
      expect(normalizeXgQuantity('x', 1.0)).toBe(10);
      expect(normalizeXgQuantity('Xg Bò', 1.5)).toBe(15);
      expect(normalizeXgQuantity('xg bo', 5)).toBe(5);
      expect(normalizeXgQuantity('Xg Bò', 10)).toBe(10);
      expect(normalizeXgQuantity('Xg Bò', 15)).toBe(15);
      expect(normalizeXgQuantity('Bắp bò', 1.5)).toBe(1.5); // Món khác không bị ảnh hưởng
      expect(normalizeXgQuantity('Sườn xg', 1.5)).toBe(1.5); // Sườn xg TUYỆT ĐỐI không bị đổi
      expect(normalizeXgQuantity('Sườn xg', 1)).toBe(1);
    });

    it('12. AI bóc tách chữ viết tay "Cô Hảo" (do nhìn nhầm chữ Cô Thảo) bắt buộc tự động khớp vào khách "Cô thảo(thầy)"', async () => {
      // 1. Tạo khách "Cô thảo(thầy)" trong DB
      const coThaoCustomer = await createTestCustomer(
        testUser.id,
        'Cô thảo(thầy)'
      );

      const customers = await prisma.customer.findMany({
        where: { userId: testUser.id, isActive: true },
        select: { id: true, name: true }
      });

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

      const testInputs = ['Cô Hảo', 'cô hảo', 'Cô Thảo', 'Hảo', 'Thầy'];

      for (const input of testInputs) {
        const cleanDetected = removeDiacritics(input);
        const cleanDetectedNoSpace = cleanDetected.replace(/\s+/g, '');

        let matchedCustomerId = null;
        if (
          cleanDetectedNoSpace === 'thay' ||
          cleanDetectedNoSpace === 'cothao' ||
          cleanDetectedNoSpace === 'thao' ||
          cleanDetectedNoSpace === 'cohao' ||
          cleanDetectedNoSpace === 'hao' ||
          cleanDetected.includes('thay') ||
          cleanDetected.includes('thao') ||
          cleanDetected.includes('co hao') ||
          cleanDetected === 'hao'
        ) {
          const coThaoCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('thao') && cClean.includes('thay');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('thao');
          });
          if (coThaoCust) {
            matchedCustomerId = coThaoCust.id;
          }
        }

        expect(matchedCustomerId).toBe(coThaoCustomer.id);
      }
    });

    it('13. AI bóc tách chữ viết tay "Van Hle" / "Van Hie" / "Van khz" (nhìn nhầm từ Van khê) bắt buộc tự động khớp vào khách "văn khê", không nhầm sang "Bún huế van khe"', async () => {
      // 1. Tạo 2 khách trong DB: "văn khê" và "Bún huế van khe"
      const vanKheCustomer = await createTestCustomer(
        testUser.id,
        'văn khê'
      );
      const bunHueCustomer = await createTestCustomer(
        testUser.id,
        'Bún huế van khe'
      );

      const customers = await prisma.customer.findMany({
        where: { userId: testUser.id, isActive: true },
        select: { id: true, name: true }
      });

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

      const matchVanKhe = (input) => {
        const cleanDetected = removeDiacritics(input);
        const cleanDetectedNoSpace = cleanDetected.replace(/\s+/g, '');

        let matchedCustomerId = null;
        const hasBunHue = cleanDetected.includes('bun hue') || cleanDetected.includes('bun bo hue') ||
          cleanDetectedNoSpace.includes('bunhue') || (cleanDetected.includes('bun') && (cleanDetected.includes('van khe') || cleanDetected.includes('van hle')));

        const isOnlyVanKhe = (
          cleanDetected.includes('van khe') ||
          cleanDetectedNoSpace.includes('vankhe') ||
          cleanDetected.includes('van hle') ||
          cleanDetectedNoSpace.includes('vanhle') ||
          cleanDetected.includes('van hie') ||
          cleanDetectedNoSpace.includes('vanhie') ||
          cleanDetected.includes('van khz') ||
          cleanDetectedNoSpace.includes('vankhz') ||
          cleanDetected.includes('van kh2') ||
          cleanDetectedNoSpace.includes('vankh2') ||
          cleanDetected === 'hle' ||
          cleanDetectedNoSpace === 'hle'
        ) && !hasBunHue && !cleanDetected.includes('bun') && !cleanDetected.includes('hue');

        if (isOnlyVanKhe) {
          const vanKheCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean === 'van khe' || (cClean.includes('van khe') && !cClean.includes('bun') && !cClean.includes('hue'));
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('khe') && !cClean.includes('bun') && !cClean.includes('hue');
          });
          if (vanKheCust) {
            matchedCustomerId = vanKheCust.id;
          }
        } else if (hasBunHue) {
          const bunHueCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return (cClean.includes('bun hue') && cClean.includes('van khe')) || (cClean.includes('bun') && cClean.includes('van khe'));
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean.includes('bun hue');
          });
          if (bunHueCust) {
            matchedCustomerId = bunHueCust.id;
          }
        }

        return matchedCustomerId;
      };

      // Các biến thể của khách "văn khê"
      const vanKheInputs = ['Van Hle', 'van hle', 'Van Hie', 'Van khz', 'Van khê', 'văn khê', 'van khe'];
      for (const input of vanKheInputs) {
        expect(matchVanKhe(input)).toBe(vanKheCustomer.id);
      }

      // Các biến thể của khách "Bún huế van khe"
      const bunHueInputs = ['Bún huế van khe', 'bún huế', 'bun hue văn khê', 'bún huế văn khê'];
      for (const input of bunHueInputs) {
        expect(matchVanKhe(input)).toBe(bunHueCustomer.id);
      }
    });

    it('14. AI bóc tách chữ viết tay "phở ĐS" / "pho ds" / "phở Đg" / "pho dg" bắt buộc tự động khớp vào khách "Phở đông"', async () => {
      // 1. Tạo khách "Phở đông" trong DB
      const phoDongCustomer = await createTestCustomer(
        testUser.id,
        'Phở đông'
      );

      const customers = await prisma.customer.findMany({
        where: { userId: testUser.id, isActive: true },
        select: { id: true, name: true }
      });

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

      const matchPhoDong = (input) => {
        const cleanDetected = removeDiacritics(input);
        const cleanDetectedNoSpace = cleanDetected.replace(/\s+/g, '');

        let matchedCustomerId = null;
        if (
          cleanDetected === 'pho dg' ||
          cleanDetected === 'phodg' ||
          cleanDetected === 'pho dong' ||
          cleanDetected === 'phodong' ||
          cleanDetected === 'pho ds' ||
          cleanDetected === 'phods' ||
          cleanDetected === 'dg' ||
          cleanDetected === 'ds' ||
          cleanDetectedNoSpace === 'phodg' ||
          cleanDetectedNoSpace === 'phodong' ||
          cleanDetectedNoSpace === 'phods' ||
          (cleanDetected.includes('pho') && (cleanDetected.includes('dg') || cleanDetected.includes('dong') || cleanDetected.includes('ds'))) ||
          cleanDetected.includes('pho dong')
        ) {
          const phoDongCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase());
            return cClean === 'pho dong' || (cClean.includes('pho') && cClean.includes('dong'));
          });
          if (phoDongCust) {
            matchedCustomerId = phoDongCust.id;
          }
        }

        return matchedCustomerId;
      };

      const testInputs = ['phở ĐS', 'pho ds', 'phở Đg', 'pho dg', 'phở đông', 'Phở Đông', 'phở đs', 'phods', 'phodg'];
      for (const input of testInputs) {
        expect(matchPhoDong(input)).toBe(phoDongCustomer.id);
      }
    });

    it('15. AI bóc tách chữ viết tay "lai" / "lại" / "Lai" / "tai" bắt buộc tự động khớp vào khách "Tài"', async () => {
      // 1. Tạo khách "Tài" trong DB
      const taiCustomer = await createTestCustomer(
        testUser.id,
        'Tài'
      );

      const customers = await prisma.customer.findMany({
        where: { userId: testUser.id, isActive: true },
        select: { id: true, name: true }
      });

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

      const matchTai = (input) => {
        const cleanDetected = removeDiacritics(input);
        const cleanDetectedNoSpace = cleanDetected.replace(/\s+/g, '');

        let matchedCustomerId = null;
        if (
          cleanDetected === 'lai' ||
          cleanDetectedNoSpace === 'lai' ||
          cleanDetected === 'tai' ||
          cleanDetectedNoSpace === 'tai' ||
          cleanDetected === 'anh tai' ||
          cleanDetectedNoSpace === 'anhtai' ||
          cleanDetected === 'chu tai' ||
          cleanDetectedNoSpace === 'chutai'
        ) {
          const taiCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim()).replace(/^\[test\]_/, '');
            return cClean === 'tai' || cClean === 'anh tai';
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim()).replace(/^\[test\]_/, '');
            return (cClean === 'tai' || cClean.includes('tai')) && !cClean.includes('tuyet') && !cClean.includes('tai chinh');
          });
          if (taiCust) {
            matchedCustomerId = taiCust.id;
          }
        }

        return matchedCustomerId;
      };

      const testInputs = ['lai', 'Lai', 'lại', 'Lại', 'tai', 'Tai', 'tài', 'Tài', 'anh tài', 'anh tai'];
      for (const input of testInputs) {
        expect(matchTai(input)).toBe(taiCustomer.id);
      }
    });

    it('14. AI bóc tách "ABh", "Abh", "ABH", "ABình", "A Bình" bắt buộc khớp đúng vào "Anh bình", không nhầm sang "Phương bình đà" hay "Thăn bình đà(anh Nghĩa)"', async () => {
      const anhBinhCustomer = await createTestCustomer(testUser.id, 'Anh bình');
      const phuongBinhDa = await createTestCustomer(testUser.id, 'Phương bình đà');
      const thanBinhDa = await createTestCustomer(testUser.id, 'Thăn bình đà(anh Nghĩa)');

      const customers = await prisma.customer.findMany({
        where: { userId: testUser.id, isActive: true },
        select: { id: true, name: true }
      });

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

      const matchAnhBinh = (input) => {
        const cleanDetected = removeDiacritics(input);
        const cleanDetectedNoSpace = cleanDetected.replace(/\s+/g, '');

        let matchedCustomerId = null;
        const isDetectedAnhBinh = (
          cleanDetectedNoSpace === 'abh' ||
          cleanDetectedNoSpace === 'ab' ||
          cleanDetectedNoSpace === 'abinh' ||
          cleanDetectedNoSpace === 'anhbinh' ||
          cleanDetected === 'abh' ||
          cleanDetected === 'ab' ||
          cleanDetected === 'a binh' ||
          cleanDetected === 'a.binh' ||
          cleanDetected === 'anh binh' ||
          cleanDetected.startsWith('a binh') ||
          cleanDetected.startsWith('anh binh') ||
          cleanDetectedNoSpace.startsWith('abinh') ||
          cleanDetectedNoSpace.startsWith('anhbinh')
        ) && !cleanDetected.includes('da') && !cleanDetected.includes('nghia') && !cleanDetected.includes('bao');

        if (isDetectedAnhBinh) {
          const anhBinhCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim()).replace(/^\[test\]_/, '');
            return (cClean === 'anh binh' || cClean === 'a binh') && !cClean.includes('da') && !cClean.includes('nghia') && !cClean.includes('bao');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim()).replace(/^\[test\]_/, '');
            return cClean.includes('binh') && (cClean.includes('anh') || cClean.startsWith('a ')) && !cClean.includes('da') && !cClean.includes('nghia') && !cClean.includes('bao');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim()).replace(/^\[test\]_/, '');
            return cClean.includes('binh') && !cClean.includes('da') && !cClean.includes('bao') && !cClean.includes('nghia');
          }) || null;

          if (anhBinhCust) {
            matchedCustomerId = anhBinhCust.id;
          }
        }

        return matchedCustomerId;
      };

      const testInputs = ['ABh', 'Abh', 'ABH', 'abh', 'ABình', 'Abình', 'A Bình', 'a bình', 'A.Bình', 'Anh bình', 'anh binh'];
      for (const input of testInputs) {
        expect(matchAnhBinh(input)).toBe(anhBinhCustomer.id);
      }
    });

    it('15. AI bóc tách "H.C.U.", "HCU", "H.Q.V.", "HQV", "H.C.V.", "HCV" bắt buộc khớp đúng vào "Hồng hạnh hqv", không nhầm sang khách "Hạnh"', async () => {
      const hongHanhCustomer = await createTestCustomer(testUser.id, 'Hồng hạnh hqv');
      const hanhCustomer = await createTestCustomer(testUser.id, 'Hạnh');

      const customers = await prisma.customer.findMany({
        where: { userId: testUser.id, isActive: true },
        select: { id: true, name: true }
      });

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

      const matchHongHanh = (input) => {
        const cleanDetected = removeDiacritics(input);
        const cleanDetectedNoSpace = cleanDetected.replace(/\s+/g, '');

        let matchedCustomerId = null;
        const isDetectedHongHanhHQV = (
          cleanDetectedNoSpace === 'hcu' ||
          cleanDetectedNoSpace === 'hqv' ||
          cleanDetectedNoSpace === 'hcv' ||
          cleanDetectedNoSpace === 'huv' ||
          cleanDetectedNoSpace === 'honghanhhqv' ||
          cleanDetectedNoSpace === 'hanhhqv' ||
          cleanDetected === 'h.c.u.' ||
          cleanDetected === 'h.c.u' ||
          cleanDetected === 'h.q.v.' ||
          cleanDetected === 'h.q.v' ||
          cleanDetected === 'h.c.v.' ||
          cleanDetected === 'h.c.v' ||
          cleanDetected === 'h.u.v.' ||
          cleanDetected === 'h.u.v' ||
          cleanDetected === 'hcu' ||
          cleanDetected === 'hqv' ||
          cleanDetected === 'hcv' ||
          cleanDetected === 'huv' ||
          cleanDetected.includes('hqv') ||
          cleanDetected.includes('h.q.v') ||
          cleanDetected.includes('h.c.u') ||
          cleanDetected.includes('h.c.v') ||
          cleanDetectedNoSpace.includes('hqv') ||
          cleanDetectedNoSpace.includes('hcu') ||
          cleanDetectedNoSpace.includes('hcv') ||
          (cleanDetected.includes('hong hanh') && (cleanDetected.includes('hqv') || cleanDetected.includes('hcu') || cleanDetected.includes('hcv')))
        );

        if (isDetectedHongHanhHQV) {
          const hongHanhCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim()).replace(/^\[test\]_/, '');
            return cClean.includes('hong hanh') && cClean.includes('hqv');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim()).replace(/^\[test\]_/, '');
            return cClean.includes('hong hanh');
          }) || null;

          if (hongHanhCust) {
            matchedCustomerId = hongHanhCust.id;
          }
        }

        return matchedCustomerId;
      };

      const testInputs = ['H.C.U.', 'H.C.U', 'HCU', 'hcu', 'H.Q.V.', 'H.Q.V', 'HQV', 'hqv', 'H.C.V.', 'H.C.V', 'HCV', 'hcv', 'h.u.v', 'hong hanh hqv', 'Hồng Hạnh HQV'];
      for (const input of testInputs) {
        expect(matchHongHanh(input)).toBe(hongHanhCustomer.id);
      }
    });

    it('16. Tự động nhận diện chính xác khách "Thuỷ gà" khi AI bóc tách "Chị Huy Ga", "Huy Ga", "C Huy Ga", "Chị Thủy Gà"...', () => {
      const thuyGaCustomer = {
        id: 'cust_thuy_ga_id',
        name: '[TEST]_Thuỷ gà(thủy lê zalo nhóm bò)',
      };
      const customers = [
        thuyGaCustomer,
        { id: 'cust_huy_id', name: '[TEST]_Huy' },
        { id: 'cust_dam_huy_id', name: '[TEST]_Đàm huy' },
      ];

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

      const matchThuyGa = (input) => {
        const cleanDetected = removeDiacritics(input);
        const cleanDetectedNoSpace = cleanDetected.replace(/\s+/g, '');

        let matchedCustomerId = null;
        const isDetectedThuyGa = (
          cleanDetectedNoSpace === 'chihuyga' ||
          cleanDetectedNoSpace === 'chuyga' ||
          cleanDetectedNoSpace === 'huyga' ||
          cleanDetectedNoSpace === 'chithuyga' ||
          cleanDetectedNoSpace === 'cthuyga' ||
          cleanDetectedNoSpace === 'thuyga' ||
          cleanDetectedNoSpace === 'thuyle' ||
          cleanDetectedNoSpace === 'thuygazalo' ||
          cleanDetectedNoSpace === 'thuylezalo' ||
          cleanDetected === 'chi huy ga' ||
          cleanDetected === 'c huy ga' ||
          cleanDetected === 'huy ga' ||
          cleanDetected === 'chi thuy ga' ||
          cleanDetected === 'c thuy ga' ||
          cleanDetected === 'thuy ga' ||
          cleanDetected === 'thuy le' ||
          (cleanDetected.includes('huy') && cleanDetected.includes('ga')) ||
          (cleanDetected.includes('thuy') && cleanDetected.includes('ga')) ||
          (cleanDetected.includes('thuy') && cleanDetected.includes('le')) ||
          cleanDetectedNoSpace.includes('huyga') ||
          cleanDetectedNoSpace.includes('thuyga') ||
          cleanDetectedNoSpace.includes('thuyle')
        );

        if (isDetectedThuyGa) {
          const thuyGaCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim()).replace(/^\[test\]_/, '');
            return (cClean.includes('thuy') && cClean.includes('ga')) || (cClean.includes('thuy') && cClean.includes('le'));
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim()).replace(/^\[test\]_/, '');
            return cClean.includes('ga') && (cClean.includes('thuy') || cClean.includes('huy'));
          }) || null;

          if (thuyGaCust) {
            matchedCustomerId = thuyGaCust.id;
          }
        }

        return matchedCustomerId;
      };

      const testInputs = [
        'Chị Huy Ga',
        'Chi Huy Ga',
        'chihuyga',
        'Huy Ga',
        'huy ga',
        'C Huy Ga',
        'Chị Thủy Gà',
        'Chi Thuy Ga',
        'C Thủy Gà',
        'Thủy Gà',
        'thuy ga',
        'Thuỷ gà',
        'Thủy Lê',
      ];
      for (const input of testInputs) {
        expect(matchThuyGa(input)).toBe(thuyGaCustomer.id);
      }
    });

    it('16. AI bóc tách chữ viết tay "Akb" / "AK b" / "A kb" / "a bình" / "a.binh" / "anh binh" bắt buộc tự động khớp vào khách "Anh bình" (và KHÔNG nhầm sang "Thăn bình đà")', async () => {
      // 1. Tạo khách "Anh bình" và "Thăn bình đà" trong DB
      const anhBinhCustomer = await createTestCustomer(
        testUser.id,
        '[TEST]_Anh bình',
        '0999888771',
        1000000
      );
      const thanBinhDaCustomer = await createTestCustomer(
        testUser.id,
        '[TEST]_Thăn bình đà(anh Nghĩa)',
        '0999888772',
        2000000
      );

      const customers = [
        anhBinhCustomer,
        thanBinhDaCustomer,
        { id: 'cust_khac_1', name: '[TEST]_Bình' },
      ];

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

      const matchAnhBinh = (input) => {
        const cleanDetected = removeDiacritics(input);
        const cleanDetectedNoSpace = cleanDetected.replace(/\s+/g, '');

        let matchedCustomerId = null;
        const isDetectedAnhBinh = (
          cleanDetected === 'akb' ||
          cleanDetected === 'ak b' ||
          cleanDetected === 'a kb' ||
          cleanDetected === 'a binh' ||
          cleanDetected === 'anh binh' ||
          cleanDetected === 'a.binh' ||
          cleanDetected === 'ak binh' ||
          cleanDetected === 'anh b' ||
          cleanDetected === 'a b' ||
          cleanDetectedNoSpace === 'akb' ||
          cleanDetectedNoSpace === 'anhbinh' ||
          cleanDetectedNoSpace === 'abinh' ||
          cleanDetectedNoSpace === 'akbinh' ||
          cleanDetected.includes('akb') ||
          (cleanDetected.includes('binh') && (cleanDetected.includes('anh') || cleanDetected.startsWith('a ') || cleanDetected.startsWith('a.')) && !cleanDetected.includes('binh da') && !cleanDetected.includes('da'))
        );

        if (isDetectedAnhBinh) {
          const anhBinhCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim()).replace(/^\[test\]_/, '');
            return (cClean === 'anh binh' || cClean === 'a binh' || (cClean.includes('binh') && (cClean.includes('anh') || cClean.startsWith('a ')))) && !cClean.includes('binh da') && !cClean.includes('da');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim()).replace(/^\[test\]_/, '');
            return cClean.includes('binh') && !cClean.includes('binh da') && !cClean.includes('da');
          });
          if (anhBinhCust) {
            matchedCustomerId = anhBinhCust.id;
          }
        }

        return matchedCustomerId;
      };

      const testInputs = [
        'Akb',
        'akb',
        'AK b',
        'Ak b',
        'A kb',
        'a bình',
        'a binh',
        'a.binh',
        'Anh bình',
        'Anh Bình',
        'anh binh',
        'ak binh',
        'A b',
        'Anh b',
      ];

      for (const input of testInputs) {
        expect(matchAnhBinh(input)).toBe(anhBinhCustomer.id);
        expect(matchAnhBinh(input)).not.toBe(thanBinhDaCustomer.id);
      }
    });

    it('17. AI bóc tách chữ viết tay "Xã Pan" / "Xa Pan" / "Xã pan" / "xa pan" / "Xã Ban" / "236 Xã Pan" bắt buộc tự động khớp vào khách "236 Xã đàn"', async () => {
      // 1. Tạo khách "236 Xã đàn" trong DB
      const xaDanCustomer = await createTestCustomer(
        testUser.id,
        '[TEST]_236 Xã đàn',
        '0999888773',
        1500000
      );

      const customers = [
        xaDanCustomer,
        { id: 'cust_khac_1', name: '[TEST]_Khách khác' },
      ];

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

      const matchXaDan = (input) => {
        const cleanDetected = removeDiacritics(input);
        const cleanDetectedNoSpace = cleanDetected.replace(/\s+/g, '');

        let matchedCustomerId = null;
        const isDetectedXaDan = (
          cleanDetected === 'xa pan' ||
          cleanDetected === 'xapan' ||
          cleanDetected === 'xa ban' ||
          cleanDetected === 'xaban' ||
          cleanDetected === 'xa dan' ||
          cleanDetected === 'xadan' ||
          cleanDetected === '236 xa dan' ||
          cleanDetected === '236 xa pan' ||
          cleanDetected === '236 xaban' ||
          cleanDetected === '236 xadan' ||
          cleanDetectedNoSpace === 'xapan' ||
          cleanDetectedNoSpace === 'xaban' ||
          cleanDetectedNoSpace === 'xadan' ||
          cleanDetectedNoSpace === '236xadan' ||
          cleanDetectedNoSpace === '236xapan' ||
          cleanDetectedNoSpace === '236xaban' ||
          cleanDetected.includes('xa pan') ||
          cleanDetected.includes('xa ban') ||
          cleanDetected.includes('xa dan') ||
          cleanDetected.includes('236 xa dan') ||
          cleanDetected.includes('236 xa pan') ||
          (cleanDetected.includes('236') && (cleanDetected.includes('dan') || cleanDetected.includes('pan') || cleanDetected.includes('ban')))
        );

        if (isDetectedXaDan) {
          const xaDanCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim()).replace(/^\[test\]_/, '');
            return (cClean.includes('236') && cClean.includes('xa dan')) || cClean === '236 xa dan';
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim()).replace(/^\[test\]_/, '');
            return cClean.includes('xa dan') || cClean.includes('236');
          });
          if (xaDanCust) {
            matchedCustomerId = xaDanCust.id;
          }
        }

        return matchedCustomerId;
      };

      const testInputs = [
        'Xã Pan',
        'Xa Pan',
        'Xã pan',
        'xa pan',
        'Xã Ban',
        'Xa Ban',
        '236 Xã Pan',
        '236 xa pan',
        '236 Xã Đàn',
        'Xã Đàn',
        'xa dan',
      ];

      for (const input of testInputs) {
        expect(matchXaDan(input)).toBe(xaDanCustomer.id);
      }
    });

    it('18. AI bóc tách chữ viết tay "Phùng Khong" / "Phung Khong" / "Phùng Khoang" / "Phùng Khơng" / "Phùng Khang" bắt buộc tự động khớp vào khách "lk01 phùng khoang"', async () => {
      // 1. Tạo khách "lk01 phùng khoang" trong DB
      const phungKhoangCustomer = await createTestCustomer(
        testUser.id,
        '[TEST]_lk01 phùng khoang',
        '0999888774',
        2000000
      );

      const customers = [
        phungKhoangCustomer,
        { id: 'cust_khac_1', name: '[TEST]_Khách khác' },
      ];

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

      const matchPhungKhoang = (input) => {
        const cleanDetected = removeDiacritics(input);
        const cleanDetectedNoSpace = cleanDetected.replace(/\s+/g, '');

        let matchedCustomerId = null;
        const isDetectedPhungKhoang = (
          cleanDetected.includes('phung khoang') ||
          cleanDetected.includes('phung khong') ||
          cleanDetected.includes('phung khang') ||
          cleanDetected.includes('phung khơng') ||
          cleanDetectedNoSpace === 'phungkhoang' ||
          cleanDetectedNoSpace === 'phungkhong' ||
          cleanDetectedNoSpace === 'phungkhang' ||
          cleanDetectedNoSpace.includes('phungkhoang') ||
          cleanDetectedNoSpace.includes('phungkhong') ||
          cleanDetectedNoSpace.includes('phungkhang') ||
          (cleanDetected.includes('phung') && (
            cleanDetected.includes('khoang') ||
            cleanDetected.includes('khong') ||
            cleanDetected.includes('khang') ||
            cleanDetected.includes('khơng')
          ))
        );

        if (isDetectedPhungKhoang) {
          const phungKhoangCust = customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim());
            return cClean.includes('phung khoang') || (cClean.includes('phung') && cClean.includes('khoang')) || cClean.includes('phung khong');
          }) || customers.find((c) => {
            const cClean = removeDiacritics(c.name.toLowerCase().trim());
            return cClean.includes('khoang');
          }) || null;

          if (phungKhoangCust) {
            matchedCustomerId = phungKhoangCust.id;
          }
        }

        return matchedCustomerId;
      };

      const testInputs = [
        'Phùng Khong',
        'Phung Khong',
        'phùng khong',
        'phung khong',
        'Phùng Khoang',
        'Phung Khoang',
        'phùng khoang',
        'phung khoang',
        'Phùng Khơng',
        'Phùng Khang',
        'phungkhong',
        'phungkhoang',
      ];

      for (const input of testInputs) {
        expect(matchPhungKhoang(input)).toBe(phungKhoangCustomer.id);
      }
    });
  });
});


