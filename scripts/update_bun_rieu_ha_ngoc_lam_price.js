// meat-management-be/scripts/update_bun_rieu_ha_ngoc_lam_price.js
// Mục đích: Cập nhật giá RIÊNG sản phẩm "Diềm thăn" cho khách "Bún riêu HA ngọc lâm"
// lên 220.000 VNĐ/kg trong bảng CustomerProductPrice.
// KHÔNG thay đổi lịch sử đơn nợ (TransactionItem) cũ.
// KHÔNG ảnh hưởng đến bất kỳ khách hàng nào khác.
//
// Cách dùng:
//   node scripts/update_bun_rieu_ha_ngoc_lam_price.js          --> Chạy DRY RUN (chỉ xem trước, không ghi DB)
//   node scripts/update_bun_rieu_ha_ngoc_lam_price.js --commit  --> Thực thi thật sự

require('dotenv').config();
const prisma = require('../src/utils/db');

// ─────────────────────────────────────────────────
// CẤU HÌNH - đã xác nhận bởi người dùng ngày 03/10/2026
// ─────────────────────────────────────────────────
const NEW_PRICE = 220000; // 220.000 đ

// Từ khóa bắt buộc phải có ĐỒng THỜI trong tên khách hàng (không phân biệt hoa/thường)
// → Đảm bảo chỉ match đúng "Bún riêu HA ngọc lâm", không ảnh hưởng khách khác
const REQUIRED_KEYWORDS = ['ngọc lâm', 'bún riêu'];

// ID sản phẩm đã được xác nhận chính xác bởi người dùng:
// Tên: "Diềm thăn" | Giá mặc định: 240.000đ | isActive: true
// Đã loại trừ "Diềm thăn thái" (fcf437ca) và "Diềm thăn bò" (6ddaeba8)
const EXACT_PRODUCT_ID = 'ef346f4d-974b-49f9-8613-768c1874bab8';

// ─────────────────────────────────────────────────
// KIỂM TRA CHẾ ĐỘ THỰC THI
// ─────────────────────────────────────────────────
const IS_COMMIT = process.argv.includes('--commit');
const MODE_LABEL = IS_COMMIT ? '⚡ COMMIT (GHI THẬT VÀO DB)' : '👁  DRY RUN (CHỈ XEM TRƯỚC - KHÔNG GHI DB)';

// Hàm kiểm tra tên khách hàng phải chứa TẤT CẢ từ khóa bắt buộc
function matchesAllKeywords(name) {
  const lower = name.toLowerCase();
  return REQUIRED_KEYWORDS.every((kw) => lower.includes(kw.toLowerCase()));
}

async function run() {
  console.log('========================================================');
  console.log('CẬP NHẬT GIÁ RIÊNG DIỀM THĂN - BÚN RIÊU HA NGỌC LÂM');
  console.log(`Chế độ: ${MODE_LABEL}`);
  console.log(`Giá mới: ${NEW_PRICE.toLocaleString('vi-VN')} đ/kg`);
  console.log(`Điều kiện lọc khách hàng: tên PHẢI chứa đồng thời: ${REQUIRED_KEYWORDS.map((k) => `"${k}"`).join(' VÀ ')}`);
  console.log('========================================================\n');

  // ── BƯỚC 1: Tìm tất cả khách hàng có "ngọc lâm" trong tên (lưới rộng trước)
  console.log('--- BƯỚC 1: Tìm kiếm khách hàng theo từ khóa ---');
  const allMatched = await prisma.customer.findMany({
    where: {
      name: {
        contains: 'ngọc lâm',
        mode: 'insensitive',
      },
    },
    select: { id: true, name: true, userId: true, isActive: true },
  });

  console.log(`Tìm được ${allMatched.length} khách hàng có "ngọc lâm" trong tên:`);
  allMatched.forEach((c, i) => {
    console.log(`  ${i + 1}. [${c.id}] "${c.name}" (isActive: ${c.isActive})`);
  });

  // ── Lọc chặt: phải chứa ĐỦ TẤT CẢ từ khóa bắt buộc
  const targetCustomers = allMatched.filter((c) => matchesAllKeywords(c.name));

  console.log(`\nSau khi lọc theo ĐẦY ĐỦ từ khóa [${REQUIRED_KEYWORDS.map((k) => `"${k}"`).join(', ')}]:`);

  if (targetCustomers.length === 0) {
    console.error('❌ DỪNG LẠI: Không tìm thấy khách hàng nào khớp đầy đủ tất cả từ khóa. Không có thay đổi nào được thực hiện.');
    return;
  }

  // ── Bảo vệ: nếu match nhiều hơn 1 → yêu cầu người dùng xác nhận ID cụ thể
  if (targetCustomers.length > 1) {
    console.error('⚠ CẢNH BÁO: Tìm thấy NHIỀU HƠN 1 khách hàng khớp. Dừng script để tránh cập nhật nhầm:');
    targetCustomers.forEach((c, i) => {
      console.error(`  ${i + 1}. [${c.id}] "${c.name}"`);
    });
    console.error('\n→ Hãy chỉ định CUSTOMER_ID cụ thể trong script để an toàn. Không có thay đổi nào được thực hiện.');
    return;
  }

  const targetCustomer = targetCustomers[0];
  console.log(`  ✓ DUY NHẤT 1 khách hàng được chọn: [${targetCustomer.id}] "${targetCustomer.name}"\n`);

  // ── BƯỚC 2: Tra cứu sản phẩm "Diềm thăn" bằng ID đã xác nhận chính xác
  console.log('--- BƯỚC 2: Xác minh sản phẩm "Diềm thăn" theo ID đã xác nhận ---');
  const { userId } = targetCustomer;

  const targetProduct = await prisma.product.findUnique({
    where: { id: EXACT_PRODUCT_ID },
    select: { id: true, name: true, defaultPrice: true, unit: true, isActive: true, userId: true },
  });

  if (!targetProduct) {
    console.error(`❌ DỪNG LẠI: Không tìm thấy sản phẩm ID [${EXACT_PRODUCT_ID}]. Không có thay đổi nào được thực hiện.`);
    return;
  }

  // Kiểm tra sản phẩm thuộc đúng chủ buôn của khách hàng
  if (targetProduct.userId !== userId) {
    console.error(`❌ DỪNG LẠI: Sản phẩm [${targetProduct.name}] không thuộc cùng chủ buôn với khách hàng. Không có thay đổi nào được thực hiện.`);
    return;
  }

  console.log(`  ✓ Sản phẩm xác minh: [${targetProduct.id}] "${targetProduct.name}" - Giá mặc định: ${Number(targetProduct.defaultPrice).toLocaleString('vi-VN')} đ/${targetProduct.unit} (isActive: ${targetProduct.isActive})\n`);

  // ── BƯỚC 3: Kiểm tra giá riêng hiện tại (trước khi thay đổi)
  console.log('--- BƯỚC 3: Kiểm tra giá riêng hiện tại ---');
  const existingPrice = await prisma.customerProductPrice.findUnique({
    where: {
      customerId_productId: {
        customerId: targetCustomer.id,
        productId: targetProduct.id,
      },
    },
  });

  const oldPrice = existingPrice ? Number(existingPrice.price) : null;
  const oldPriceLabel = oldPrice !== null
    ? `${oldPrice.toLocaleString('vi-VN')} đ`
    : `(chưa thiết lập - đang dùng giá mặc định: ${Number(targetProduct.defaultPrice).toLocaleString('vi-VN')} đ)`;

  console.log(`  Khách hàng:      "${targetCustomer.name}"`);
  console.log(`  Sản phẩm:        "${targetProduct.name}"`);
  console.log(`  Giá riêng hiện tại: ${oldPriceLabel}`);
  console.log(`  Giá riêng mới:      ${NEW_PRICE.toLocaleString('vi-VN')} đ\n`);

  if (oldPrice === NEW_PRICE) {
    console.log('ℹ Giá riêng hiện tại đã là 220.000 đ rồi, không cần cập nhật. Kết thúc script.');
    return;
  }

  // ── BƯỚC 4: Thực thi (hoặc chỉ hiển thị nếu DRY RUN)
  if (!IS_COMMIT) {
    console.log('========================================================');
    console.log('👁  DRY RUN - Kết quả nếu chạy thật:');
    console.log(`  Sẽ upsert CustomerProductPrice:`);
    console.log(`    customerId:  ${targetCustomer.id}`);
    console.log(`    productId:   ${targetProduct.id}`);
    console.log(`    price:       ${NEW_PRICE.toLocaleString('vi-VN')} đ`);
    console.log(`  Lịch sử đơn nợ cũ: KHÔNG thay đổi`);
    console.log(`  Khách hàng khác:    KHÔNG bị ảnh hưởng`);
    console.log('\n→ Chạy lại với --commit để áp dụng thật:\n');
    console.log('  node scripts/update_bun_rieu_ha_ngoc_lam_price.js --commit');
    console.log('========================================================\n');
    return;
  }

  // ── Chạy thật: upsert duy nhất 1 bản ghi CustomerProductPrice
  console.log('--- BƯỚC 4: Ghi vào database ---');

  await prisma.customerProductPrice.upsert({
    where: {
      customerId_productId: {
        customerId: targetCustomer.id,
        productId: targetProduct.id,
      },
    },
    update: {
      price: NEW_PRICE,
      changeReason: `Cập nhật giá riêng diềm thăn lên ${NEW_PRICE.toLocaleString('vi-VN')}đ theo yêu cầu chủ buôn (${new Date().toLocaleDateString('vi-VN')})`,
      updatedAt: new Date(),
    },
    create: {
      customerId: targetCustomer.id,
      productId: targetProduct.id,
      price: NEW_PRICE,
      changeReason: `Thiết lập giá riêng diềm thăn ${NEW_PRICE.toLocaleString('vi-VN')}đ theo yêu cầu chủ buôn (${new Date().toLocaleDateString('vi-VN')})`,
    },
  });

  console.log(`  ✓ Đã upsert thành công: "${targetCustomer.name}" - "${targetProduct.name}" → ${NEW_PRICE.toLocaleString('vi-VN')} đ`);

  // ── BƯỚC 5: Ghi ActivityLog
  console.log('\n--- BƯỚC 5: Ghi nhật ký hệ thống ---');
  try {
    await prisma.activityLog.create({
      data: {
        userId,
        action: 'UPDATE_CUSTOMER_PRICE',
        details: `[ĐỔI GIÁ RIÊNG] "${targetCustomer.name}" - Diềm thăn: ${oldPriceLabel} → ${NEW_PRICE.toLocaleString('vi-VN')}đ. (Lịch sử đơn nợ cũ KHÔNG thay đổi, khách hàng khác KHÔNG bị ảnh hưởng)`,
        device: 'Script / Server Admin',
      },
    });
    console.log('  ✓ Đã ghi vào ActivityLog thành công.');
  } catch (logErr) {
    console.warn('  ⚠ Không thể ghi ActivityLog:', logErr.message);
  }

  // ── KẾT QUẢ CUỐI
  console.log('\n========================================================');
  console.log('✅ HOÀN THÀNH THỰC THI');
  console.log('========================================================');
  console.log(`  Khách hàng cập nhật:   "${targetCustomer.name}"`);
  console.log(`  Sản phẩm:              "${targetProduct.name}"`);
  console.log(`  Giá cũ:                ${oldPriceLabel}`);
  console.log(`  Giá mới:               ${NEW_PRICE.toLocaleString('vi-VN')} đ/kg`);
  console.log(`  Bản ghi DB thay đổi:   1 bản ghi CustomerProductPrice (duy nhất)`);
  console.log(`  Lịch sử đơn nợ cũ:    KHÔNG thay đổi`);
  console.log(`  Khách hàng khác:       KHÔNG bị ảnh hưởng`);
  console.log('========================================================\n');
}

run()
  .catch((e) => {
    console.error('❌ LỖI THỰC THI:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
