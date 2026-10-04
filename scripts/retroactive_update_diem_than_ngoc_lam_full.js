// meat-management-be/scripts/retroactive_update_diem_than_ngoc_lam_full.js
// Cập nhật HỒI TỐ toàn bộ lịch sử: tất cả dòng có "diềm thăn" (mọi variant)
// của khách "Bún riêu HA ngọc lâm" → giá 220.000đ
//
// Phát hiện qua scan 03/10/2026:
//   - 50 dòng [Diềm thăn thái] từ 05/07 → 31/08/2026 đang ghi giá 215.000đ ❌
//   - 34 dòng từ 01/09 → 03/10/2026 đã đúng 220.000đ ✓
//
// Cách dùng:
//   node scripts/retroactive_update_diem_than_ngoc_lam_full.js           → DRY RUN
//   node scripts/retroactive_update_diem_than_ngoc_lam_full.js --commit  → GHI THẬT

require('dotenv').config();
const prisma = require('../src/utils/db');

// ── Khóa cứng để đảm bảo chỉ ảnh hưởng đúng khách này ──
const CUSTOMER_ID   = 'c7ddec81-35db-4bb3-b528-63cec02185e3';
const CUSTOMER_NAME = 'Bún riêu HA ngọc lâm';
const NEW_PRICE     = 220000;

// Các productId "diềm thăn" được phép cập nhật (đã xác nhận)
const ALLOWED_PRODUCT_IDS = [
  'ef346f4d-974b-49f9-8613-768c1874bab8', // Diềm thăn
  'fcf437ca-315e-4916-82ca-fc3953ee01be', // Diềm thăn thái
];

const IS_COMMIT  = process.argv.includes('--commit');
const MODE_LABEL = IS_COMMIT
  ? '⚡ COMMIT — GHI THẬT VÀO DATABASE'
  : '👁  DRY RUN — CHỈ XEM TRƯỚC, KHÔNG GHI DB';

async function run() {
  console.log('============================================================');
  console.log('CẬP NHẬT HỒI TỐ TOÀN BỘ DIỀM THĂN → 220.000đ');
  console.log(`Chế độ  : ${MODE_LABEL}`);
  console.log(`Khách   : "${CUSTOMER_NAME}" [${CUSTOMER_ID}]`);
  console.log(`Sản phẩm: Diềm thăn + Diềm thăn thái (2 variant)`);
  console.log(`Giá mới : ${NEW_PRICE.toLocaleString('vi-VN')} đ/kg`);
  console.log('============================================================\n');

  // ── Xác minh khách hàng
  const customer = await prisma.customer.findUnique({
    where: { id: CUSTOMER_ID },
    select: { id: true, name: true, userId: true },
  });
  if (!customer || customer.name !== CUSTOMER_NAME) {
    console.error('❌ DỪNG: Xác minh khách hàng thất bại. Không có thay đổi nào.');
    return;
  }
  console.log(`  ✓ Khách hàng: "${customer.name}"\n`);

  // ── Lấy toàn bộ TransactionItem "diềm thăn" của khách này (không lọc ngày)
  const allItems = await prisma.transactionItem.findMany({
    where: {
      productId: { in: ALLOWED_PRODUCT_IDS },
      transaction: { customerId: CUSTOMER_ID },
    },
    include: {
      product: { select: { id: true, name: true } },
      transaction: {
        select: { id: true, date: true, totalAmount: true, totalCost: true, totalProfit: true },
      },
    },
    orderBy: { transaction: { date: 'asc' } },
  });

  console.log(`Tổng dòng TransactionItem diềm thăn: ${allItems.length}`);

  const needUpdate = allItems.filter((i) => Number(i.price) !== NEW_PRICE);
  const alreadyOk  = allItems.filter((i) => Number(i.price) === NEW_PRICE);

  console.log(`  Đã đúng 220k : ${alreadyOk.length} dòng`);
  console.log(`  Cần cập nhật : ${needUpdate.length} dòng\n`);

  if (needUpdate.length === 0) {
    console.log('✅ Tất cả dòng đã đúng giá 220k. Không cần cập nhật.');
    return;
  }

  // ── Tính toán thay đổi
  let oldTotalSum = 0;
  let newTotalSum = 0;

  console.log('--- CHI TIẾT CÁC DÒNG CẦN CẬP NHẬT ---');
  for (const item of needUpdate) {
    const oldPrice  = Number(item.price);
    const qty       = Number(item.quantity);
    const costPrice = Number(item.costPrice || 0);
    const oldAmount = Number(item.amount);
    const newAmount = Math.round(qty * NEW_PRICE);
    const diff      = newAmount - oldAmount;
    const txDate    = new Date(item.transaction.date).toLocaleDateString('vi-VN');
    oldTotalSum += oldAmount;
    newTotalSum += newAmount;
    console.log(
      `  ${txDate} | ${item.product.name} | ${qty}kg × ${oldPrice.toLocaleString('vi-VN')}đ → ${NEW_PRICE.toLocaleString('vi-VN')}đ` +
      ` | ${oldAmount.toLocaleString('vi-VN')} → ${newAmount.toLocaleString('vi-VN')} đ (${diff >= 0 ? '+' : ''}${diff.toLocaleString('vi-VN')}đ)`
    );
  }

  const totalDiff = newTotalSum - oldTotalSum;
  console.log('\n  ─'.repeat(35));
  console.log(`  Tổng thành tiền cũ : ${oldTotalSum.toLocaleString('vi-VN')} đ`);
  console.log(`  Tổng thành tiền mới: ${newTotalSum.toLocaleString('vi-VN')} đ`);
  console.log(`  Chênh lệch tổng    : ${totalDiff >= 0 ? '+' : ''}${totalDiff.toLocaleString('vi-VN')} đ`);

  if (!IS_COMMIT) {
    console.log('\n============================================================');
    console.log('👁  DRY RUN HOÀN TẤT — Không có thay đổi nào được ghi vào DB.');
    console.log('→  Chạy lại với --commit để áp dụng:');
    console.log('   node scripts/retroactive_update_diem_than_ngoc_lam_full.js --commit');
    console.log('============================================================\n');
    return;
  }

  // ── COMMIT: Cập nhật từng item và tính lại Transaction
  console.log('\n--- GHI VÀO DATABASE ---');

  // Nhóm theo transactionId
  const txMap = new Map();
  for (const item of allItems) {
    const txId = item.transactionId;
    if (!txMap.has(txId)) {
      txMap.set(txId, { tx: item.transaction, items: [] });
    }
    txMap.get(txId).items.push(item);
  }

  let updatedItemCount = 0;
  let updatedTxCount   = 0;

  for (const [txId, { tx, items }] of txMap.entries()) {
    let txHasChange = false;

    for (const item of items) {
      const oldPrice = Number(item.price);
      if (oldPrice === NEW_PRICE) continue; // Đã đúng → bỏ qua

      const qty       = Number(item.quantity);
      const costPrice = Number(item.costPrice || 0);
      const newAmount = Math.round(qty * NEW_PRICE);
      const newProfit = newAmount - Math.round(qty * costPrice);

      await prisma.transactionItem.update({
        where: { id: item.id },
        data: { price: NEW_PRICE, amount: newAmount, profit: newProfit },
      });
      updatedItemCount++;
      txHasChange = true;
    }

    if (!txHasChange) continue;

    // Tính lại totalAmount và totalProfit cho đơn nợ này
    // (lấy lại tất cả items của đơn sau khi đã cập nhật)
    const allTxItems = await prisma.transactionItem.findMany({
      where: { transactionId: txId },
      select: { amount: true, profit: true },
    });
    const newTxTotal  = allTxItems.reduce((s, i) => s + Number(i.amount), 0);
    const newTxProfit = allTxItems.reduce((s, i) => s + Number(i.profit), 0);
    const oldTxTotal  = Number(tx.totalAmount);

    await prisma.transaction.update({
      where: { id: txId },
      data: { totalAmount: newTxTotal, totalProfit: newTxProfit, updatedAt: new Date() },
    });
    updatedTxCount++;

    const txDate = new Date(tx.date).toLocaleDateString('vi-VN');
    const diff   = newTxTotal - oldTxTotal;
    console.log(
      `  ✓ Đơn ${txDate}: ${oldTxTotal.toLocaleString('vi-VN')} → ${newTxTotal.toLocaleString('vi-VN')} đ` +
      ` (${diff >= 0 ? '+' : ''}${diff.toLocaleString('vi-VN')}đ)`
    );
  }

  // ── Ghi ActivityLog
  try {
    await prisma.activityLog.create({
      data: {
        userId: customer.userId,
        action: 'RETROACTIVE_PRICE_UPDATE',
        details:
          `[CẬP NHẬT HỒI TỐ] "${CUSTOMER_NAME}" - Diềm thăn (tất cả variant): ` +
          `${updatedItemCount} dòng × 220.000đ. ${updatedTxCount} đơn nợ được tính lại. ` +
          `Chênh lệch: ${totalDiff >= 0 ? '+' : ''}${totalDiff.toLocaleString('vi-VN')}đ. ` +
          `(CHỈ khách "${CUSTOMER_NAME}", không ảnh hưởng khách khác)`,
        device: 'Script / Server Admin',
      },
    });
    console.log('\n  ✓ Đã ghi ActivityLog.');
  } catch (e) {
    console.warn('  ⚠ Không ghi được ActivityLog:', e.message);
  }

  // ── Kết quả cuối
  console.log('\n============================================================');
  console.log('✅ HOÀN THÀNH');
  console.log('============================================================');
  console.log(`  Khách hàng:          "${CUSTOMER_NAME}"`);
  console.log(`  Dòng đã cập nhật:    ${updatedItemCount} TransactionItem`);
  console.log(`  Đơn nợ đã tính lại:  ${updatedTxCount} Transaction`);
  console.log(`  Chênh lệch tổng:     ${totalDiff >= 0 ? '+' : ''}${totalDiff.toLocaleString('vi-VN')} đ`);
  console.log(`  Khách hàng khác:     KHÔNG bị ảnh hưởng`);
  console.log('============================================================\n');
}

run()
  .catch((e) => { console.error('❌ LỖI:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
