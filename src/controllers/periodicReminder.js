// meat-management-be/src/controllers/periodicReminder.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');

// Cấu hình danh mục 22 nhà hàng gợi ý ban đầu để tự động liên kết khi chưa có cấu hình
const DEFAULT_RESTAURANTS_SEED = [
  // ─── 1. CHUỖI TRƯỜNG HOÀNG (11 NHÀ HÀNG) ───
  { matchTerms: ['373 kim mã', 'kim mã'], groupName: 'Chuỗi Trường Hoàng (11 quán)', reminderDays: '1,15' },
  { matchTerms: ['126 nguyễn khánh toàn', 'nguyễn khánh toàn'], groupName: 'Chuỗi Trường Hoàng (11 quán)', reminderDays: '1,15' },
  { matchTerms: ['trường hoàng(nguyễn khuyến)', 'trường hoàng', 'nguyễn khuyến 1'], groupName: 'Chuỗi Trường Hoàng (11 quán)', reminderDays: '1,15' },
  { matchTerms: ['cuốn an khánh', 'an khánh'], groupName: 'Chuỗi Trường Hoàng (11 quán)', reminderDays: '1,15' },
  { matchTerms: ['giảng võ'], groupName: 'Chuỗi Trường Hoàng (11 quán)', reminderDays: '1,15' },
  { matchTerms: ['cuốn láng hạ'], groupName: 'Chuỗi Trường Hoàng (11 quán)', reminderDays: '1,15' },
  { matchTerms: ['52 trần thái tông', '52  trần thái tông'], groupName: 'Chuỗi Trường Hoàng (11 quán)', reminderDays: '1,15' },
  { matchTerms: ['236 xã đàn', 'xã đàn'], groupName: 'Chuỗi Trường Hoàng (11 quán)', reminderDays: '1,15' },
  { matchTerms: ['268 khương đình', 'khương đình'], groupName: 'Chuỗi Trường Hoàng (11 quán)', reminderDays: '1,15' },
  { matchTerms: ['hàm nghi'], groupName: 'Chuỗi Trường Hoàng (11 quán)', reminderDays: '1,15' },
  { matchTerms: ['47trần thái tông', '47 trần thái tông'], groupName: 'Chuỗi Trường Hoàng (11 quán)', reminderDays: '1,15' },

  // ─── 2. BẾP HÀNG XÓM (3 NHÀ HÀNG) ───
  { matchTerms: ['bếp hàng xóm 1', 'hàng xóm 1', 'bếp hàng xóm 1(b1)'], groupName: 'Bếp Hàng Xóm (3 cơ sở)', reminderDays: '1,15' },
  { matchTerms: ['bếp hàng xóm 2', 'hàng xóm 2', 'bếp hàng xóm 2(b2)'], groupName: 'Bếp Hàng Xóm (3 cơ sở)', reminderDays: '1,15' },
  { matchTerms: ['bếp hàng xóm 3', 'hàng xóm 3', 'bếp hàng xóm 3(b3)'], groupName: 'Bếp Hàng Xóm (3 cơ sở)', reminderDays: '1,15' },

  // ─── 3. CÁC NHÀ HÀNG RIÊNG LẺ (8 NHÀ HÀNG) ───
  { matchTerms: ['bếp 3 miền', 'bếp ba miền', '3 miền kim liên'], groupName: 'Các nhà hàng riêng lẻ', reminderDays: '1,15' },
  { matchTerms: ['industree', '794 láng hạ', '794 đường láng', 'the industree'], groupName: 'Các nhà hàng riêng lẻ', reminderDays: '1,15' },
  { matchTerms: ['trung kính', 'bếp trung kính'], groupName: 'Các nhà hàng riêng lẻ', reminderDays: '1,15' },
  { matchTerms: ['vườn xanh', 'nhà hàng vườn xanh', 'bếp vườn xanh'], groupName: 'Các nhà hàng riêng lẻ', reminderDays: '1,15' },
  { matchTerms: ['ngọc lâm', 'bún riêu ha ngọc lâm'], groupName: 'Các nhà hàng riêng lẻ', reminderDays: '1,15' },
  { matchTerms: ['lk', 'lẩu ốc', 'lk(lẩu ốc)'], groupName: 'Các nhà hàng riêng lẻ', reminderDays: '1,15' },
  { matchTerms: ['chị thúy nga', 'thúy nga'], groupName: 'Các nhà hàng riêng lẻ', reminderDays: '1,15' },
  { matchTerms: ['hồng hạnh', 'hồng hạnh hqv'], groupName: 'Các nhà hàng riêng lẻ', reminderDays: '1,15' },
];

/**
 * 1. Lấy danh sách cấu hình nhắc nợ định kỳ của người dùng
 * Nếu chưa từng có cấu hình nào trong DB, tự động liên kết các khách hàng hiện có với 22 mẫu mặc định
 */
const getPeriodicReminders = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;

    let configs = await prisma.periodicReminderConfig.findMany({
      where: { userId },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
            address: true,
            isActive: true,
            isBadDebt: true,
          },
        },
      },
      orderBy: [
        { groupName: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    // Nếu chưa có cấu hình nào trong DB, tự động tìm và seed từ khách hàng sẵn có
    if (configs.length === 0) {
      const allCustomers = await prisma.customer.findMany({
        where: { userId, isActive: true, isBadDebt: false },
        select: { id: true, name: true, phone: true },
      });

      const seedData = [];
      const usedCustomerIds = new Set();

      for (const item of DEFAULT_RESTAURANTS_SEED) {
        const lowerTerms = item.matchTerms.map((t) => t.toLowerCase());
        const matched = allCustomers.find((c) => {
          if (usedCustomerIds.has(c.id)) return false;
          const cName = (c.name || '').toLowerCase();
          return lowerTerms.some((term) => cName.includes(term));
        });

        if (matched) {
          usedCustomerIds.add(matched.id);
          seedData.push({
            userId,
            customerId: matched.id,
            groupName: item.groupName,
            reminderDays: item.reminderDays,
          });
        }
      }

      if (seedData.length > 0) {
        await prisma.periodicReminderConfig.createMany({
          data: seedData,
          skipDuplicates: true,
        });

        configs = await prisma.periodicReminderConfig.findMany({
          where: { userId },
          include: {
            customer: {
              select: {
                id: true,
                name: true,
                phone: true,
                address: true,
                isActive: true,
                isBadDebt: true,
              },
            },
          },
          orderBy: [
            { groupName: 'asc' },
            { createdAt: 'asc' },
          ],
        });
      }
    }

    res.status(200).json({
      success: true,
      data: configs,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 2. Thêm mới hoặc cập nhật cấu hình nhắc nợ cho một khách hàng
 */
const upsertPeriodicReminder = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { customerId, reminderDays, groupName, notes } = req.body;

    if (!customerId) {
      throw new BadRequestError('Vui lòng chọn khách hàng cần nhắc nợ.');
    }

    // Kiểm tra khách hàng có tồn tại và thuộc quyền quản lý của chủ buôn này không
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, userId, isActive: true },
      select: { id: true, name: true },
    });

    if (!customer) {
      throw new NotFoundError('Khách hàng không tồn tại hoặc không thuộc quyền quản lý của bạn.');
    }

    // Chuẩn hóa ngày nhắc nợ (mặc định "1,15" nếu không truyền)
    const validDays = reminderDays && typeof reminderDays === 'string' ? reminderDays.trim() : '1,15';
    const validGroupName = groupName && typeof groupName === 'string' ? groupName.trim() : 'Các nhà hàng riêng lẻ';

    const result = await prisma.periodicReminderConfig.upsert({
      where: {
        userId_customerId: {
          userId,
          customerId,
        },
      },
      update: {
        reminderDays: validDays,
        groupName: validGroupName,
        notes: notes || null,
      },
      create: {
        userId,
        customerId,
        reminderDays: validDays,
        groupName: validGroupName,
        notes: notes || null,
      },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
            address: true,
          },
        },
      },
    });

    await logActivity(
      userId,
      'UPDATE_PERIODIC_REMINDER',
      `Cấu hình lịch gửi công nợ cho khách hàng "${customer.name}": Nhắc ngày [${validDays}], Nhóm: "${validGroupName}"`
    );

    res.status(200).json({
      success: true,
      message: 'Lưu cấu hình nhắc nợ thành công.',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 3. Cập nhật cấu hình nhắc nợ theo ID bản ghi
 */
const updatePeriodicReminder = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;
    const { reminderDays, groupName, notes } = req.body;

    const existing = await prisma.periodicReminderConfig.findFirst({
      where: { id, userId },
      include: { customer: { select: { name: true } } },
    });

    if (!existing) {
      throw new NotFoundError('Không tìm thấy cấu hình nhắc nợ này.');
    }

    const updated = await prisma.periodicReminderConfig.update({
      where: { id },
      data: {
        reminderDays: reminderDays !== undefined ? reminderDays : existing.reminderDays,
        groupName: groupName !== undefined ? groupName : existing.groupName,
        notes: notes !== undefined ? notes : existing.notes,
      },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
    });

    res.status(200).json({
      success: true,
      message: 'Cập nhật cấu hình nhắc nợ thành công.',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 4. Xóa cấu hình nhắc nợ của một khách hàng (gỡ khỏi danh sách nhắc nợ)
 */
const deletePeriodicReminder = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;

    const existing = await prisma.periodicReminderConfig.findFirst({
      where: { id, userId },
      include: { customer: { select: { name: true } } },
    });

    if (!existing) {
      throw new NotFoundError('Không tìm thấy cấu hình nhắc nợ để xóa.');
    }

    await prisma.periodicReminderConfig.delete({
      where: { id },
    });

    await logActivity(
      userId,
      'DELETE_PERIODIC_REMINDER',
      `Gỡ khách hàng "${existing.customer?.name || 'ẩn'}" khỏi danh sách gửi công nợ định kỳ`
    );

    res.status(200).json({
      success: true,
      message: 'Đã gỡ khách hàng khỏi danh sách nhắc nợ.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getPeriodicReminders,
  upsertPeriodicReminder,
  updatePeriodicReminder,
  deletePeriodicReminder,
};
