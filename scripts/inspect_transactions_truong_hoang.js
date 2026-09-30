// meat-management-be/scripts/inspect_transactions_truong_hoang.js
require('dotenv').config();
const prisma = require('../src/utils/db');

async function main() {
  const customerIds = [
    '5e60ad93-e7eb-4fa1-9c6f-c0c116d17101',
    'b7c3120d-7e33-4546-a8be-5ef7c29df069',
    'fd1b4658-be2e-463d-af97-ff735e03839b',
    '4877fb04-3cb1-4b2e-9ac7-25e0c7384086',
    '1fd93d90-aa1d-49c5-8c4c-c65c17cd7345',
    '1752a4f4-6803-4520-8416-6a9854ffc395',
    'ae16c050-d8a6-4c20-bdae-d046217e53e2',
    '99a81a9d-9f7e-4cd0-9827-dfb6e1d948de',
    'caf315e5-2bce-4c2f-8bdf-0ce3f50d17d6',
    'cf682149-6cf2-468b-b86d-460438b1839c',
    '115f69b2-1d28-43b1-8671-fd193176bee0',
  ];

  // Từ 2026-09-01 00:00:00 (giờ VN GMT+7)
  const startDate = new Date('2026-09-01T00:00:00+07:00');

  console.log('Quét các đơn nợ từ ngày:', startDate.toISOString());

  const transactions = await prisma.transaction.findMany({
    where: {
      customerId: { in: customerIds },
      date: { gte: startDate },
    },
    include: {
      customer: { select: { id: true, name: true } },
      items: {
        include: {
          product: { select: { id: true, name: true, defaultPrice: true } },
        },
      },
    },
    orderBy: { date: 'asc' },
  });

  console.log(`Tìm thấy tổng cộng ${transactions.length} đơn nợ từ 01/09/2026 của nhóm Trường Hoàng.\n`);

  // Thống kê các loại tên sản phẩm xuất hiện trong các đơn nợ này
  const productStats = {};

  transactions.forEach((tx) => {
    tx.items.forEach((item) => {
      const pName = (item.product?.name || item.productName || 'Không tên').trim();
      const pId = item.productId || 'NO_ID';
      const key = `${pName} (id: ${pId})`;

      if (!productStats[key]) {
        productStats[key] = {
          productName: pName,
          productId: pId,
          count: 0,
          currentPrices: new Set(),
        };
      }
      productStats[key].count += 1;
      productStats[key].currentPrices.add(Number(item.price));
    });
  });

  console.log('=== CÁC SẢN PHẨM TRONG ĐƠN TỪ 01/09/2026 CỦA NHÓM TRƯỜNG HOÀNG ===');
  Object.keys(productStats).forEach((k) => {
    const s = productStats[k];
    console.log(`- ${s.productName} (ID: ${s.productId}): ${s.count} dòng, Giá hiện tại: [${Array.from(s.currentPrices).map(p => p.toLocaleString('vi-VN')).join(', ')}]`);
  });

  // Kiểm tra bảng giá riêng CustomerProductPrice hiện tại của 11 khách hàng này
  console.log('\n=== BẢNG GIÁ RIÊNG HIỆN TẠI (CustomerProductPrice) CỦA 11 KHÁCH HÀNG ===');
  const customPrices = await prisma.customerProductPrice.findMany({
    where: {
      customerId: { in: customerIds },
    },
    include: {
      customer: { select: { name: true } },
      product: { select: { name: true } },
    },
  });

  console.log(`Có ${customPrices.length} bản ghi giá riêng:`);
  customPrices.forEach((cp) => {
    console.log(`   - KH "${cp.customer?.name}" -> Món "${cp.product?.name}": ${Number(cp.customPrice).toLocaleString('vi-VN')} đ`);
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
