require('dotenv').config();
const prisma = require('../src/utils/db');

async function main() {
  console.log('=== KIỂM TRA NHÓM TRƯỜNG HOÀNG TRONG HỆ THỐNG ===');

  // 1. Tìm trong PortalLink
  const portalLinks = await prisma.portalLink.findMany({
    where: {
      name: { contains: 'Trường Hoàng', mode: 'insensitive' },
    },
    include: {
      customers: {
        include: {
          customer: {
            select: { id: true, name: true, phone: true, address: true, isActive: true },
          },
        },
      },
    },
  });

  console.log(`Tìm thấy ${portalLinks.length} PortalLink khớp 'Trường Hoàng':`);
  portalLinks.forEach((link, idx) => {
    console.log(`\n[PortalLink #${idx + 1}] ID: ${link.id}, Tên: "${link.name}", Số KH: ${link.customers.length}`);
    link.customers.forEach((c, cIdx) => {
      console.log(`   ${cIdx + 1}. [${c.customer?.id}] ${c.customer?.name} (isActive: ${c.customer?.isActive})`);
    });
  });

  // Nếu không thấy trong PortalLink, tìm khách hàng có tên chứa 'Trường Hoàng'
  const customers = await prisma.customer.findMany({
    where: {
      name: { contains: 'Trường Hoàng', mode: 'insensitive' },
    },
    select: { id: true, name: true, phone: true, isActive: true },
  });
  console.log(`\nTìm thấy ${customers.length} khách hàng có tên chứa 'Trường Hoàng':`);
  customers.forEach((c, idx) => {
    console.log(`   ${idx + 1}. [${c.id}] ${c.name} (isActive: ${c.isActive})`);
  });

  // 2. Tìm danh mục sản phẩm liên quan đến: "thăn bò", "sườn bò", "sườn", "gầu"
  console.log('\n=== TÌM SẢN PHẨM THỊT LIÊN QUAN ===');
  const products = await prisma.product.findMany({
    where: {
      isActive: true,
      OR: [
        { name: { contains: 'thăn', mode: 'insensitive' } },
        { name: { contains: 'sườn', mode: 'insensitive' } },
        { name: { contains: 'gầu', mode: 'insensitive' } },
      ],
    },
    select: { id: true, name: true, defaultPrice: true, unit: true, userId: true },
  });

  console.log(`Tìm thấy ${products.length} sản phẩm:`);
  products.forEach((p, idx) => {
    console.log(`   ${idx + 1}. [${p.id}] ${p.name} - Giá mặc định: ${Number(p.defaultPrice).toLocaleString('vi-VN')} đ/${p.unit}`);
  });
}

main()
  .catch((e) => {
    console.error('Lỗi kiểm tra:', e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
