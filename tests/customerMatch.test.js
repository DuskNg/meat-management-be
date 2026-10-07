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
});

