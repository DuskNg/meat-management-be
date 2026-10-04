// meat-management-be/scripts/retroactive_update_diem_than_ngoc_lam.js
// Mục đích: Cập nhật HỒI TỐ (retroactive) tất cả dòng TransactionItem có sản phẩm
//           "Diềm thăn" của khách "Bún riêu HA ngọc lâm" về đơn giá 220.000đ.
//           Tính lại amount (= quantity * 220000) và cập nhật lại totalAmount của đơn nợ.
//
// PHẠM VI: CHỈ khách hàng "Bún riêu HA ngọc lâm" — KHÔNG ảnh hưởng bất kỳ khách nào khác.
//
// Cách dùng:
//   node scripts/retroactive_update_diem_than_ngoc_lam.js          --> DRY RUN (chỉ xem trước)
//   node scripts/retroactive_update_diem_than_ngoc_lam.js --commit  --> Thực thi thật

require('dotenv').config();
const prisma = require('../src/utils/db');

// ──────────────────────────────────────────────────────
// CẤU HÌNH ĐÃ XÁC NHẬN (khóa cứng ID để tránh nhầm lẫn)
// ──────────────────────────────────────────────────────

// Khách hàng: "Bún riêu HA ngọc lâm" — đã xác nhận qua DRY RUN ngày 03/10/2026
const CUSTOMER_ID   = 'c7ddec81-35db-4bb3-b528-63cec02185e3';
const CUSTOMER_NAME = 'Bún riêu HA ngọc lâm';

// Sản phẩm: "Diềm thăn" — đã xác nhận qua DRY RUN ngày 03/10/2026
// (Loại trừ "Diềm thăn thái" và "Diềm thăn bò")
const PRODUCT_ID   = 'ef346f4d-974b-49f9-8613-768c1874bab8';
const PRODUCT_NAME = 'Diềm thăn';

// Giá mới áp dụng (VNĐ)
const NEW_PRICE = 220000;

// ──────────────────────────────────────────────────────
const IS_COMMIT  = process.argv.includes('--commit');
const MODE_LABEL = IS_COMMIT
  ? '⚡ COMMIT — GHI THẬT VÀO DATABASE'
  : '👁  DRY RUN — CHỈ XEM TRƯỚC, KHÔNG GHI DB';

async function run() {
  console.log('============================================================');
  console.log('CẬP NHẬT HỒI TỐ GIÁ DIỀM THĂN → 220.000đ');
  console.log(`Chế độ  : ${MODE_LABEL}`);
  console.log(`Khách   : "${CUSTOMER_NAME}" [${CUSTOMER_ID}]`);
  console.log(`Sản phẩm: "${PRODUCT_NAME}" [${PRODUCT_ID}]`);
  console.log(`Giá mới : ${NEW_PRICE.toLocaleString('vi-VN')} đ/kg`);
  console.log('============================================================\n');

  // ── BƯỚC 1: Xác minh khách hàng tồn tại và đúng ID
  console.log('--- BƯỚC 1: Xác minh khách hàng ---');
  const customer = await prisma.customer.findUnique({
    where: { id: CUSTOMER_ID },
    select: { id: true, name: true, userId: true, isActive: true },
  });

  if (!customer) {
    console.error(`❌ DỪNG: Không tìm thấy khách hàng ID [${CUSTOMER_ID}]. Không có thay đổi nào.`);
    return;
  }
  if (customer.name !== CUSTOMER_NAME) {
    console.error(`❌ DỪNG: Tên khách hàng không khớp!\n  Trong DB: "${customer.name}"\n  Mong đợi: "${CUSTOMER_NAME}"\n  Không có thay đổi nào.`);
    return;
  }
  console.log(`  ✓ Khách hàng hợp lệ: [${customer.id}] "${customer.name}" (isActive: ${customer.isActive})\n`);

  // ── BƯỚC 2: Xác minh sản phẩm tồn tại và đúng ID
  console.log('--- BƯỚC 2: Xác minh sản phẩm ---');
  const product = await prisma.product.findUnique({
    where: { id: PRODUCT_ID },
    select: { id: true, name: true, defaultPrice: true, userId: true },
  });

  if (!product) {
    console.error(`❌ DỪNG: Không tìm thấy sản phẩm ID [${PRODUCT_ID}]. Không có thay đổi nào.`);
    return;
  }
  if (product.userId !== customer.userId) {
    console.error(`❌ DỪNG: Sản phẩm không thuộc cùng chủ buôn với khách hàng. Không có thay đổi nào.`);
    return;
  }
  console.log(`  ✓ Sản phẩm hợp lệ: [${product.id}] "${product.name}" (Giá mặc định: ${Number(product.defaultPrice).toLocaleString('vi-VN')} đ)\n`);

  // ── BƯỚC 3: Lấy toàn bộ TransactionItem của khách này có sản phẩm "Diềm thăn"
  console.log('--- BƯỚC 3: Quét toàn bộ dòng đơn nợ cần cập nhật ---');
  const items = await prisma.transactionItem.findMany({
    where: {
      productId: PRODUCT_ID,
      transaction: {
        customerId: CUSTOMER_ID, // Chỉ đơn của khách này
      },
    },
    include: {
      transaction: {
        select: { id: true, date: true, totalAmount: true, totalCost: true, totalProfit: true },
      },
    },
    orderBy: {
      transaction: { date: 'asc' },
    },
  });

  console.log(`  Tìm thấy ${items.length} dòng TransactionItem có "${PRODUCT_NAME}" của khách "${CUSTOMER_NAME}".\n`);

  if (items.length === 0) {
    console.log('ℹ Không có dòng nào cần cập nhật. Kết thúc script.');
    return;
  }

  // ── BƯỚC 4: Phân tích từng dòng — tính toán thay đổi
  console.log('--- BƯỚC 4: Chi tiết thay đổi từng dòng ---');
  console.log('─'.repeat(80));

  // Nhóm các thay đổi theo transaction
  const txChanges = new Map(); // txId → { tx, itemChanges[], oldTxTotal, newTxTotal }

  let totalItemsNeedUpdate = 0;
  let totalItemsAlreadyCorrect = 0;
  let totalOldAmount = 0;
  let totalNewAmount = 0;

  for (const item of items) {
    const oldPrice  = Number(item.price);
    const qty       = Number(item.quantity);
    const costPrice = Number(item.costPrice || 0);
    const oldAmount = Number(item.amount);

    // Tính lại
    const newAmount  = Math.round(qty * NEW_PRICE);
    const newProfit  = newAmount - Math.round(qty * costPrice);
    const diffAmount = newAmount - oldAmount;

    const txId = item.transactionId;
    const txDate = item.transaction.date
      ? new Date(item.transaction.date).toLocaleDateString('vi-VN')
      : '?';

    if (oldPrice === NEW_PRICE) {
      totalItemsAlreadyCorrect++;
      console.log(
        `  [OK] Ngày ${txDate} | Qty: ${qty}kg | Giá: ${oldPrice.toLocaleString('vi-VN')}đ (đã đúng) | Amount: ${oldAmount.toLocaleString('vi-VN')}đ`
      );

      // Vẫn cần track để tính lại totalAmount đúng
      if (!txChanges.has(txId)) {
        txChanges.set(txId, {
          tx: item.transaction,
          itemsData: [],
        });
      }
      txChanges.get(txId).itemsData.push({
        id: item.id,
        oldPrice,
        newPrice: NEW_PRICE,
        qty,
        oldAmount,
        newAmount,
        newProfit,
        diffAmount,
        needsUpdate: false,
      });
    } else {
      totalItemsNeedUpdate++;
      console.log(
        `  [SỬA] Ngày ${txDate} | Qty: ${qty}kg | Giá: ${oldPrice.toLocaleString('vi-VN')}đ → ${NEW_PRICE.toLocaleString('vi-VN')}đ | Amount: ${oldAmount.toLocaleString('vi-VN')}đ → ${newAmount.toLocaleString('vi-VN')}đ (${diffAmount >= 0 ? '+' : ''}${diffAmount.toLocaleString('vi-VN')}đ)`
      );

      if (!txChanges.has(txId)) {
        txChanges.set(txId, {
          tx: item.transaction,
          itemsData: [],
        });
      }
      txChanges.get(txId).itemsData.push({
        id: item.id,
        oldPrice,
        newPrice: NEW_PRICE,
        qty,
        oldAmount,
        newAmount,
        newProfit,
        diffAmount,
        needsUpdate: true,
      });
    }

    totalOldAmount += oldAmount;
    totalNewAmount += newAmount;
  }

  console.log('─'.repeat(80));
  console.log(`  Tổng: ${items.length} dòng | Cần sửa: ${totalItemsNeedUpdate} | Đã đúng: ${totalItemsAlreadyCorrect}`);
  console.log(`  Tổng thành tiền cũ: ${totalOldAmount.toLocaleString('vi-VN')} đ`);
  console.log(`  Tổng thành tiền mới: ${totalNewAmount.toLocaleString('vi-VN')} đ`);
  console.log(`  Chênh lệch tổng: ${(totalNewAmount - totalOldAmount) >= 0 ? '+' : ''}${(totalNewAmount - totalOldAmount).toLocaleString('vi-VN')} đ\n`);

  // ── BƯỚC 5: Tổng hợp ảnh hưởng lên các đơn nợ (Transaction)
  console.log('--- BƯỚC 5: Ảnh hưởng lên đơn nợ (Transaction) ---');

  // Với mỗi transaction bị ảnh hưởng, cần lấy TẤT CẢ items để tính lại totalAmount chính xác
  const affectedTxIds = Array.from(txChanges.keys());
  const txWithAllItems = await prisma.transaction.findMany({
    where: { id: { in: affectedTxIds } },
    include: {
      items: {
        select: { id: true, productId: true, amount: true, profit: true },
      },
    },
  });

  // Tính lại totalAmount cho từng transaction
  const txUpdatePlan = []; // { txId, oldTotal, newTotal, diff }
  let grandOldTotal = 0;
  let grandNewTotal = 0;

  for (const tx of txWithAllItems) {
    const changeData = txChanges.get(tx.id);
    const changedItemMap = new Map(changeData.itemsData.map((i) => [i.id, i]));

    let newTxTotal  = 0;
    let newTxProfit = 0;

    for (const txItem of tx.items) {
      if (changedItemMap.has(txItem.id)) {
        const changed = changedItemMap.get(txItem.id);
        newTxTotal  += changed.newAmount;
        newTxProfit += changed.newProfit;
      } else {
        newTxTotal  += Number(txItem.amount);
        newTxProfit += Number(txItem.profit);
      }
    }

    const oldTotal = Number(tx.totalAmount);
    const diff     = newTxTotal - oldTotal;
    const txDate   = new Date(tx.date).toLocaleDateString('vi-VN');
    const hasChange = changeData.itemsData.some((i) => i.needsUpdate);

    grandOldTotal += oldTotal;
    grandNewTotal += newTxTotal;

    txUpdatePlan.push({
      txId: tx.id,
      txDate,
      oldTotal,
      newTotal: newTxTotal,
      newProfit: newTxProfit,
      diff,
      hasChange,
    });

    const changeLabel = hasChange ? `${oldTotal.toLocaleString('vi-VN')} → ${newTxTotal.toLocaleString('vi-VN')} đ (${diff >= 0 ? '+' : ''}${diff.toLocaleString('vi-VN')} đ)` : `${oldTotal.toLocaleString('vi-VN')} đ (giữ nguyên)`;
    console.log(`  Đơn ngày ${txDate} [${tx.id.slice(0, 8)}...]: ${changeLabel}`);
  }

  const txNeedUpdate = txUpdatePlan.filter((t) => t.hasChange);
  console.log(`\n  Tổng đơn nợ bị ảnh hưởng: ${affectedTxIds.length} đơn`);
  console.log(`  Đơn cần cập nhật totalAmount: ${txNeedUpdate.length} đơn`);
  const grandDiff = grandNewTotal - grandOldTotal;
  console.log(`  Tổng công nợ thay đổi: ${grandDiff >= 0 ? '+' : ''}${grandDiff.toLocaleString('vi-VN')} đ\n`);

  // ── Nếu DRY RUN: dừng ở đây
  if (!IS_COMMIT) {
    console.log('============================================================');
    console.log('👁  DRY RUN HOÀN TẤT — Không có thay đổi nào được ghi vào DB.');
    console.log('→  Để áp dụng thật, chạy lại với --commit:');
    console.log('   node scripts/retroactive_update_diem_than_ngoc_lam.js --commit');
    console.log('============================================================\n');
    return;
  }

  // ── BƯỚC 6: Thực thi ghi vào DB (chỉ khi --commit)
  console.log('--- BƯỚC 6: Ghi vào database ---');

  let updatedItemCount = 0;
  let updatedTxCount   = 0;

  for (const plan of txUpdatePlan) {
    if (!plan.hasChange) continue; // Bỏ qua đơn không cần thay đổi

    const changeData = txChanges.get(plan.txId);

    // Cập nhật từng TransactionItem cần thay đổi
    for (const itemData of changeData.itemsData) {
      if (!itemData.needsUpdate) continue;
      await prisma.transactionItem.update({
        where: { id: itemData.id },
        data: {
          price:  NEW_PRICE,
          amount: itemData.newAmount,
          profit: itemData.newProfit,
        },
      });
      updatedItemCount++;
    }

    // Cập nhật lại totalAmount và totalProfit của đơn nợ
    await prisma.transaction.update({
      where: { id: plan.txId },
      data: {
        totalAmount: plan.newTotal,
        totalProfit: plan.newProfit,
        updatedAt:   new Date(),
      },
    });
    updatedTxCount++;
    console.log(`  ✓ Cập nhật đơn ngày ${plan.txDate}: ${plan.oldTotal.toLocaleString('vi-VN')} → ${plan.newTotal.toLocaleString('vi-VN')} đ`);
  }

  // ── BƯỚC 7: Ghi ActivityLog
  console.log('\n--- BƯỚC 7: Ghi nhật ký hệ thống ---');
  try {
    await prisma.activityLog.create({
      data: {
        userId: customer.userId,
        action: 'RETROACTIVE_PRICE_UPDATE',
        details: `[CẬP NHẬT HỒI TỐ] "${CUSTOMER_NAME}" - Sản phẩm "${PRODUCT_NAME}": ${totalItemsNeedUpdate} dòng × 220.000đ. Cập nhật ${updatedTxCount} đơn nợ. Tổng công nợ thay đổi: ${grandDiff >= 0 ? '+' : ''}${grandDiff.toLocaleString('vi-VN')}đ. (CHỈ khách "${CUSTOMER_NAME}", không ảnh hưởng khách khác)`,
        device: 'Script / Server Admin',
      },
    });
    console.log('  ✓ Đã ghi vào ActivityLog.');
  } catch (logErr) {
    console.warn('  ⚠ Không thể ghi ActivityLog:', logErr.message);
  }

  // ── KẾT QUẢ
  console.log('\n============================================================');
  console.log('✅ HOÀN THÀNH THỰC THI');
  console.log('============================================================');
  console.log(`  Khách hàng:          "${CUSTOMER_NAME}"`);
  console.log(`  Sản phẩm:            "${PRODUCT_NAME}" → Giá mới: 220.000 đ/kg`);
  console.log(`  Dòng đã cập nhật:    ${updatedItemCount} TransactionItem`);
  console.log(`  Đơn nợ đã cập nhật:  ${updatedTxCount} Transaction`);
  console.log(`  Tổng công nợ thay đổi: ${grandDiff >= 0 ? '+' : ''}${grandDiff.toLocaleString('vi-VN')} đ`);
  console.log(`  Khách hàng khác:     KHÔNG bị ảnh hưởng`);
  console.log('============================================================\n');
}

run()
  .catch((e) => {
    console.error('❌ LỖI THỰC THI:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
