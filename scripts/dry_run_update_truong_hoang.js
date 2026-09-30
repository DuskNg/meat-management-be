// meat-management-be/scripts/dry_run_update_truong_hoang.js
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

// ID các sản phẩm thịt cụ thể
const PRODUCT_THAN_BO = 'f0f68ac0-0142-4b83-bc84-dbfb7523fa3a'; // Thăn bò -> 245.000
const PRODUCT_SUON_BO = 'c8e21418-22fb-4a22-a505-a3f50d1fe967'; // Sườn bò -> 180.000
const PRODUCT_SUON = 'b8b288c0-1ba1-40ed-8adf-d45ff66d96fc';    // Sườn -> 180.000
const PRODUCT_GAU_BO = '5aaff1f7-432c-4666-846f-c742f9f14be9';  // Gầu bò -> 220.000

// Hàm xác định giá mới cho item
function getTargetPrice(item) {
  const pId = item.productId;
  const pName = (item.product?.name || item.productName || '').trim().toLowerCase();

  // 1. Thăn bò: 245.000 đ
  if (pId === PRODUCT_THAN_BO || pName === 'thăn bò') {
    return 245000;
  }

  // 2. Sườn bò & Sườn: 180.000 đ (loại trừ 'sườn xg', 'sườn thêm')
  if (pId === PRODUCT_SUON_BO || pId === PRODUCT_SUON || pName === 'sườn bò' || pName === 'sườn') {
    return 180000;
  }

  // 3. Gầu: 220.000 đ (loại trừ 'lạm gầu', 'gầu cộc')
  if (pId === PRODUCT_GAU_BO || pName === 'gầu bò' || pName === 'gầu') {
    return 220000;
  }

  return null; // Không thuộc diện đổi giá
}

async function simulate() {
  console.log('=== CHẾ ĐỘ MÔ PHỎNG (DRY-RUN): TÍNH LẠI CÔNG NỢ TỪ 01/09/2026 ===\n');

  // Ngày bắt đầu: 01/09/2026 00:00:00 (giờ VN GMT+7)
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

  console.log(`Tổng số đơn nợ quét từ 01/09/2026: ${transactions.length} đơn`);

  let affectedTxCount = 0;
  let affectedItemCount = 0;
  let totalDiff = 0;

  const customerDiffs = {};
  TARGET_CUSTOMER_IDS.forEach((id) => {
    customerDiffs[id] = {
      name: '',
      oldTotal: 0,
      newTotal: 0,
      diff: 0,
      txCount: 0,
      changedTxCount: 0,
    };
  });

  transactions.forEach((tx) => {
    const cId = tx.customerId;
    customerDiffs[cId].name = tx.customer?.name || cId;
    customerDiffs[cId].txCount += 1;

    const oldTxAmount = Number(tx.totalAmount);
    let newTxAmount = 0;
    let txChanged = false;

    tx.items.forEach((item) => {
      const targetPrice = getTargetPrice(item);
      const currentPrice = Number(item.price);
      const qty = Number(item.quantity);

      if (targetPrice !== null && targetPrice !== currentPrice) {
        txChanged = true;
        affectedItemCount += 1;
        const newTotalItem = Math.round(qty * targetPrice);
        newTxAmount += newTotalItem;
      } else {
        newTxAmount += Number(item.amount);
      }
    });

    customerDiffs[cId].oldTotal += oldTxAmount;
    customerDiffs[cId].newTotal += newTxAmount;
    const diff = newTxAmount - oldTxAmount;
    customerDiffs[cId].diff += diff;

    if (txChanged) {
      affectedTxCount += 1;
      customerDiffs[cId].changedTxCount += 1;
      totalDiff += diff;
    }
  });

  console.log('\n=== KẾT QUẢ MÔ PHỎNG CHI TIẾT THEO TỪNG NHÀ HÀNG ===');
  Object.keys(customerDiffs).forEach((cId, idx) => {
    const d = customerDiffs[cId];
    console.log(
      `${idx + 1}. [${d.name}] | Tổng đơn: ${d.txCount} (Có ${d.changedTxCount} đơn đổi giá)\n` +
      `   - Tiền nợ cũ: ${d.oldTotal.toLocaleString('vi-VN')} đ\n` +
      `   - Tiền nợ mới: ${d.newTotal.toLocaleString('vi-VN')} đ\n` +
      `   - Chênh lệch: ${d.diff > 0 ? '+' : ''}${d.diff.toLocaleString('vi-VN')} đ`
    );
  });

  console.log('\n=== TỔNG KẾT MÔ PHỎNG ===');
  console.log(`- Số đơn nợ sẽ cập nhật: ${affectedTxCount} / ${transactions.length} đơn`);
  console.log(`- Số dòng mặt hàng đổi giá: ${affectedItemCount} dòng`);
  console.log(`- Tổng công nợ chênh lệch toàn nhóm: ${totalDiff > 0 ? '+' : ''}${totalDiff.toLocaleString('vi-VN')} đ`);
}

simulate()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
