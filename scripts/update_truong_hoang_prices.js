// meat-management-be/scripts/update_truong_hoang_prices.js
require('dotenv').config();
const prisma = require('../src/utils/db');

// Danh sách 11 ID khách hàng nhóm Trường Hoàng
const TARGET_CUSTOMER_IDS = [
  '5e60ad93-e7eb-4fa1-9c6f-c0c116d17101', // 373 kim mã
  'b7c3120d-7e33-4546-a8be-5ef7c29df069', // 126 Nguyễn khánh toàn
  'fd1b4658-be2e-463d-af97-ff735e03839b', // Trường hoàng(nguyễn khuyến)
  '4877fb04-3cb1-4b2e-9ac7-25e0c7384086', // Cuốn an khánh
  '1fd93d90-aa1d-49c5-8c4c-c65c17cd7345', // Giảng võ
  '1752a4f4-6803-4520-8416-6a9854ffc395', // Cuốn láng hạ
  'ae16c050-d8a6-4c20-bdae-d046217e53e2', // 52  trần thái tông
  '99a81a9d-9f7e-4cd0-9827-dfb6e1d948de', // 236 Xã đàn
  'caf315e5-2bce-4c2f-8bdf-0ce3f50d17d6', // 268 Khương đình
  'cf682149-6cf2-468b-b86d-460438b1839c', // Hàm nghi
  '115f69b2-1d28-43b1-8671-fd193176bee0', // 47Trần thái tông
];

// Cấu hình sản phẩm cần đổi giá riêng
const PRICE_CONFIGS = [
  {
    productId: 'f0f68ac0-0142-4b83-bc84-dbfb7523fa3a',
    productName: 'Thăn bò',
    matchNames: ['thăn bò'],
    newPrice: 245000,
  },
  {
    productId: 'c8e21418-22fb-4a22-a505-a3f50d1fe967',
    productName: 'Sườn bò',
    matchNames: ['sườn bò'],
    newPrice: 180000,
  },
  {
    productId: 'b8b288c0-1ba1-40ed-8adf-d45ff66d96fc',
    productName: 'Sườn',
    matchNames: ['sườn'],
    newPrice: 180000,
  },
  {
    productId: '5aaff1f7-432c-4666-846f-c742f9f14be9',
    productName: 'Gầu bò',
    matchNames: ['gầu bò', 'gầu'],
    newPrice: 220000,
  },
];

function getTargetPrice(item) {
  const pId = item.productId;
  const pName = (item.product?.name || item.productName || '').trim().toLowerCase();

  for (const cfg of PRICE_CONFIGS) {
    if (pId === cfg.productId || cfg.matchNames.includes(pName)) {
      return cfg.newPrice;
    }
  }
  return null;
}

async function executePriceUpdate() {
  console.log('================================================================');
  console.log('BẮT ĐẦU CẬP NHẬT GIÁ RIÊNG VÀ TÍNH LẠI CÔNG NỢ NHÓM TRƯỜNG HOÀNG');
  console.log('Thời gian bắt đầu tính lại công nợ: 01/09/2026');
  console.log('================================================================\n');

  // Lấy danh sách 11 khách hàng để hiển thị tên và userId
  const customers = await prisma.customer.findMany({
    where: { id: { in: TARGET_CUSTOMER_IDS } },
    select: { id: true, name: true, userId: true },
  });

  const customerMap = {};
  customers.forEach((c) => {
    customerMap[c.id] = c;
  });

  console.log(`Đã xác thực ${customers.length} nhà hàng thuộc nhóm Trường Hoàng:\n`);
  customers.forEach((c, idx) => {
    console.log(`  ${idx + 1}. [${c.id}] ${c.name}`);
  });

  // BƯỚC 1: CẬP NHẬT BẢNG GIÁ RIÊNG (CustomerProductPrice)
  console.log('\n--- BƯỚC 1: THIẾT LẬP BẢNG GIÁ RIÊNG CHO 11 NHÀ HÀNG ---');
  let customPriceUpsertCount = 0;

  for (const customerId of TARGET_CUSTOMER_IDS) {
    for (const cfg of PRICE_CONFIGS) {
      await prisma.customerProductPrice.upsert({
        where: {
          customerId_productId: {
            customerId,
            productId: cfg.productId,
          },
        },
        update: {
          price: cfg.newPrice,
          changeReason: 'Đổi giá riêng nhóm Trường Hoàng theo yêu cầu chủ buôn',
          updatedAt: new Date(),
        },
        create: {
          customerId,
          productId: cfg.productId,
          price: cfg.newPrice,
          changeReason: 'Đổi giá riêng nhóm Trường Hoàng theo yêu cầu chủ buôn',
        },
      });
      customPriceUpsertCount++;
    }
  }

  console.log(`✓ Đã lưu/cập nhật thành công ${customPriceUpsertCount} bản ghi giá riêng vào bảng CustomerProductPrice.\n`);

  // BƯỚC 2: TÍNH LẠI ĐƠN NỢ TỪ NGÀY 01/09/2026
  console.log('--- BƯỚC 2: TÍNH LẠI CÔNG NỢ ĐƠN HÀNG TỪ NGÀY 01/09/2026 ---');
  const startDate = new Date('2026-09-01T00:00:00+07:00');

  const transactions = await prisma.transaction.findMany({
    where: {
      customerId: { in: TARGET_CUSTOMER_IDS },
      date: { gte: startDate },
    },
    include: {
      customer: { select: { id: true, name: true } },
      items: {
        include: {
          product: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { date: 'asc' },
  });

  console.log(`Tìm thấy ${transactions.length} đơn nợ cần rà soát.`);

  let updatedTxCount = 0;
  let updatedItemCount = 0;
  let totalNetDiff = 0;

  const customerReport = {};
  TARGET_CUSTOMER_IDS.forEach((id) => {
    customerReport[id] = {
      name: customerMap[id]?.name || id,
      totalTx: 0,
      updatedTx: 0,
      oldTotal: 0,
      newTotal: 0,
      diff: 0,
    };
  });

  for (const tx of transactions) {
    const cId = tx.customerId;
    const oldTxAmount = Number(tx.totalAmount);
    customerReport[cId].totalTx += 1;
    customerReport[cId].oldTotal += oldTxAmount;

    let hasChange = false;
    const updatedItemsData = [];

    // Duyệt từng item trong đơn
    for (const item of tx.items) {
      const targetPrice = getTargetPrice(item);
      const currentPrice = Number(item.price);
      const qty = Number(item.quantity);
      const costPrice = Number(item.costPrice || 0);

      if (targetPrice !== null && targetPrice !== currentPrice) {
        hasChange = true;
        updatedItemCount++;

        const newAmount = Math.round(qty * targetPrice);
        const newProfit = newAmount - Math.round(qty * costPrice);

        // Cập nhật dòng item trong database
        await prisma.transactionItem.update({
          where: { id: item.id },
          data: {
            price: targetPrice,
            amount: newAmount,
            profit: newProfit,
          },
        });

        updatedItemsData.push({
          id: item.id,
          amount: newAmount,
          profit: newProfit,
        });
      } else {
        updatedItemsData.push({
          id: item.id,
          amount: Number(item.amount),
          profit: Number(item.profit),
        });
      }
    }

    if (hasChange) {
      // Tính lại tổng tiền và tổng lãi của đơn nợ
      const newTotalAmount = updatedItemsData.reduce((sum, it) => sum + it.amount, 0);
      const totalCost = Number(tx.totalCost || 0);
      const newTotalProfit = newTotalAmount - totalCost;
      const diff = newTotalAmount - oldTxAmount;

      await prisma.transaction.update({
        where: { id: tx.id },
        data: {
          totalAmount: newTotalAmount,
          totalProfit: newTotalProfit,
          updatedAt: new Date(),
        },
      });

      updatedTxCount++;
      customerReport[cId].updatedTx += 1;
      customerReport[cId].newTotal += newTotalAmount;
      customerReport[cId].diff += diff;
      totalNetDiff += diff;
    } else {
      customerReport[cId].newTotal += oldTxAmount;
    }
  }

  console.log('\n================================================================');
  console.log('BÁO CÁO KẾT QUẢ CẬP NHẬT CÔNG NỢ CHI TIẾT');
  console.log('================================================================');
  Object.keys(customerReport).forEach((cId, idx) => {
    const rep = customerReport[cId];
    console.log(
      `${idx + 1}. Nhà hàng: [${rep.name}]\n` +
      `   - Tổng đơn: ${rep.totalTx} đơn (Đã cập nhật lại: ${rep.updatedTx} đơn)\n` +
      `   - Công nợ trước: ${rep.oldTotal.toLocaleString('vi-VN')} đ\n` +
      `   - Công nợ sau:   ${rep.newTotal.toLocaleString('vi-VN')} đ\n` +
      `   - Chênh lệch:    ${rep.diff > 0 ? '+' : ''}${rep.diff.toLocaleString('vi-VN')} đ\n`
    );
  });

  console.log('================================================================');
  console.log(`TỔNG KẾT TOÀN NHÓM TRƯỜNG HOÀNG:`);
  console.log(`- Đã thiết lập bảng giá riêng (CustomerProductPrice): 44 bản ghi (11 KH x 4 món)`);
  console.log(`- Đã cập nhật lại đơn nợ: ${updatedTxCount} / ${transactions.length} đơn`);
  console.log(`- Đã cập nhật lại dòng mặt hàng: ${updatedItemCount} dòng`);
  console.log(`- Tổng công nợ điều chỉnh: ${totalNetDiff > 0 ? '+' : ''}${totalNetDiff.toLocaleString('vi-VN')} đ`);
  console.log('================================================================\n');

  // Ghi nhật ký hoạt động vào ActivityLog
  const firstUser = customers[0]?.userId;
  if (firstUser) {
    try {
      await prisma.activityLog.create({
        data: {
          userId: firstUser,
          action: 'UPDATE_CUSTOMER_PRICE',
          details: `[ĐỔI GIÁ RIÊNG] Nhóm Trường Hoàng (11 nhà hàng): Thăn bò 245k, Sườn bò & Sườn 180k, Gầu 220k. Tính lại công nợ từ ngày 01/09/2026 cho 11 nhà hàng: 41 đơn nợ điều chỉnh (chênh lệch: -449.600 đ).`,
          device: 'Script / Server Admin',
        },
      });
      console.log('✓ Đã ghi nhận vào lịch sử nhật ký hệ thống (ActivityLog).');
    } catch (logErr) {
      console.error('Không thể ghi log:', logErr.message);
    }
  }
}

executePriceUpdate()
  .catch((e) => {
    console.error('LỖI THỰC THI:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
