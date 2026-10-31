// meat-management-be/src/controllers/employee.js
const prisma = require('../utils/db');
const jwt = require('jsonwebtoken');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');

const PORTAL_SESSION_SECRET = process.env.JWT_PORTAL_SECRET || process.env.JWT_ACCESS_SECRET || 'meat_manager_portal_secret_key_2026';

// Helper lấy tổng số ngày của một tháng bất kỳ
const getDaysInMonth = (year, month) => {
  return new Date(year, month, 0).getDate();
};

// Helper parse monthKey "MM/YYYY" ra tháng và năm
const parseMonthKey = (monthKey) => {
  const parts = monthKey.split('/');
  if (parts.length !== 2) return null;
  const month = parseInt(parts[0], 10);
  const year = parseInt(parts[1], 10);
  if (isNaN(month) || isNaN(year) || month < 1 || month > 12) return null;
  return { month, year };
};

// Helper parse chuỗi ngày linh hoạt (hỗ trợ cả DD/MM/YYYY lẫn YYYY-MM-DD)
const parseFlexibleDate = (dateStr) => {
  if (!dateStr) return null;
  if (dateStr instanceof Date) return dateStr;
  if (typeof dateStr === 'string' && dateStr.includes('/')) {
    const parts = dateStr.split('/');
    if (parts.length === 3) {
      const d = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      const y = parseInt(parts[2], 10);
      return new Date(y, m - 1, d);
    }
  }
  return new Date(dateStr);
};

// Helper tính số ngày công hợp lệ trong tháng dựa vào ngày bắt đầu vào làm (startDate)
const getEligibleDaysForEmployee = (startDate, year, month, totalDaysInMonth) => {
  if (!startDate) {
    return {
      eligibleDays: totalDaysInMonth,
      joinedMidMonth: false,
      startDayInMonth: 1,
      isBeforeJoined: false,
    };
  }

  const startD = new Date(startDate);
  const startY = startD.getFullYear();
  const startM = startD.getMonth() + 1;
  const startDay = startD.getDate();

  if (startY > year || (startY === year && startM > month)) {
    // Nhân viên chưa vào làm trong tháng này
    return {
      eligibleDays: 0,
      joinedMidMonth: false,
      startDayInMonth: totalDaysInMonth + 1,
      isBeforeJoined: true,
    };
  }

  if (startY === year && startM === month) {
    // Nhân viên vào làm giữa tháng này
    return {
      eligibleDays: Math.max(0, totalDaysInMonth - startDay + 1),
      joinedMidMonth: true,
      startDayInMonth: startDay,
      isBeforeJoined: false,
    };
  }

  // Nhân viên đã vào làm từ trước tháng này
  return {
    eligibleDays: totalDaysInMonth,
    joinedMidMonth: false,
    startDayInMonth: 1,
    isBeforeJoined: false,
  };
};

// Helper tính toán nợ lương/tiền ứng thừa lũy kế được chuyển từ tháng trước sang tháng sau
const calculateCarryOver = async (employeeId, baseSalary, targetMonthKey, empStartDate = null) => {
  let carryOver = 0;
  const parsed = parseMonthKey(targetMonthKey);
  if (!parsed) return 0;
  const { month: m, year: y } = parsed;

  let startYearMonth = null;
  if (empStartDate) {
    const sDate = new Date(empStartDate);
    startYearMonth = sDate.getFullYear() * 12 + sDate.getMonth();
  }

  const monthsList = [];
  // Truy vết ngược tối đa 12 tháng để tính toán nợ chuyển tiếp
  for (let i = 12; i >= 1; i--) {
    let tempM = m - i;
    let tempY = y;
    while (tempM <= 0) {
      tempM += 12;
      tempY -= 1;
    }
    monthsList.push({ 
      month: tempM, 
      year: tempY, 
      key: `${tempM.toString().padStart(2, '0')}/${tempY}` 
    });
  }

  for (const item of monthsList) {
    // Bỏ qua các tháng trước khi nhân viên vào làm việc
    if (startYearMonth !== null) {
      const curYearMonth = item.year * 12 + (item.month - 1);
      if (curYearMonth < startYearMonth) {
        continue;
      }
    }

    const start = new Date(item.year, item.month - 1, 1);
    const end = new Date(item.year, item.month, 0, 23, 59, 59, 999);
    
    const advances = await prisma.salaryAdvance.findMany({
      where: {
        employeeId,
        date: {
          gte: start,
          lte: end,
        }
      }
    });
    const totalAdvances = advances.reduce((sum, adv) => sum + parseFloat(adv.amount), 0);

    // Tính trừ tiền ngày nghỉ của tháng
    const attendances = await prisma.attendance.findMany({
      where: {
        employeeId,
        date: { gte: start, lte: end },
        OR: [
          { status: 'ABSENT' },
          { status: 'PRESENT', shift: 'HALF' }
        ]
      }
    });
    const daysInM = getDaysInMonth(item.year, item.month);
    let lDays = 0;
    attendances.forEach(att => {
      if (att.status === 'ABSENT') lDays += (att.shift === 'HALF' ? 0.5 : 1.0);
      else if (att.status === 'PRESENT' && att.shift === 'HALF') lDays += 0.5;
    });
    const lDeduction = Math.round(lDays * (baseSalary / daysInM));
    const effectiveSalary = Math.max(0, baseSalary - lDeduction);
    
    // Số dư còn lại của tháng = Lương thực tế sau trừ nghỉ - Tiền tạm ứng + Khoản âm mang sang từ trước
    const remaining = effectiveSalary - totalAdvances + carryOver;
    if (remaining < 0) {
      carryOver = remaining; // Nếu âm (ứng quá tay) thì tiếp tục chuyển khoản nợ này sang tháng sau
    } else {
      carryOver = 0; // Nếu dương thì đã thanh toán hết, không có nợ mang sang
    }
  }
  return carryOver;
};

// 1. Lấy toàn bộ danh sách nhân viên (hỗ trợ tính toán tạm ứng, ngày nghỉ và trạng thái trả lương theo tháng)
const getEmployees = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { monthKey } = req.query; // Định dạng "MM/YYYY"

    let startOfMonth, endOfMonth;
    let targetMonthKey = monthKey;

    if (!targetMonthKey) {
      const now = new Date();
      const mm = (now.getMonth() + 1).toString().padStart(2, '0');
      const yyyy = now.getFullYear();
      targetMonthKey = `${mm}/${yyyy}`;
    }

    const dateParsed = parseMonthKey(targetMonthKey);
    if (dateParsed) {
      const { month, year } = dateParsed;
      startOfMonth = new Date(year, month - 1, 1);
      endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);
    }

    const employees = await prisma.employee.findMany({
      where: {
        userId,
        isActive: true,
      },
      include: {
        advances: {
          where: startOfMonth ? {
            date: {
              gte: startOfMonth,
              lte: endOfMonth,
            }
          } : undefined,
          orderBy: {
            date: 'asc',
          },
        },
        attendances: {
          where: startOfMonth ? {
            date: {
              gte: startOfMonth,
              lte: endOfMonth,
            },
            OR: [
              { status: 'ABSENT' },
              { status: 'PRESENT', shift: 'HALF' }
            ]
          } : undefined,
        },
        payments: {
          where: {
            monthKey: targetMonthKey,
          }
        }
      },
      orderBy: {
        name: 'asc',
      },
    });

    const totalDaysInMonth = dateParsed ? getDaysInMonth(dateParsed.year, dateParsed.month) : 30;

    // Lấy thông tin ngày tháng hiện tại để tính lương luỹ kế đến ngày hiện tại
    const now = new Date();
    const nowYear = now.getFullYear();
    const nowMonth = now.getMonth() + 1;
    const nowDay = now.getDate();

    const targetYear = dateParsed ? dateParsed.year : nowYear;
    const targetMonth = dateParsed ? dateParsed.month : nowMonth;

    const isCurrentMonth = (targetYear === nowYear && targetMonth === nowMonth);
    const isPastMonth = (targetYear < nowYear || (targetYear === nowYear && targetMonth < nowMonth));
    const isFutureMonth = (targetYear > nowYear || (targetYear === nowYear && targetMonth > nowMonth));

    // Mốc ngày chốt tính đến hiện tại:
    // - Tháng hiện tại: lấy ngày hôm nay (tối đa bằng số ngày trong tháng)
    // - Tháng quá khứ: đã kết thúc trọn vẹn tháng, mốc là totalDaysInMonth
    // - Tháng tương lai: chưa đến, mốc là 0
    let currentDayCutoff = totalDaysInMonth;
    if (isCurrentMonth) {
      currentDayCutoff = Math.min(nowDay, totalDaysInMonth);
    } else if (isFutureMonth) {
      currentDayCutoff = 0;
    }

    const result = await Promise.all(employees.map(async (emp) => {
      const totalAdvances = emp.advances ? emp.advances.reduce((sum, adv) => sum + parseFloat(adv.amount), 0) : 0;
      
      // Tính tổng số tiền lương đã chi trả cho nhân viên trong tháng này
      const totalPaidSalary = emp.payments
        ? emp.payments
            .filter((p) => p.status === 'PAID')
            .reduce((sum, p) => sum + parseFloat(p.finalAmount || 0), 0)
        : 0;

      const baseSalary = parseFloat(emp.baseSalary);
      const dailySalary = Math.round(baseSalary / totalDaysInMonth);

      // Tính số ngày công hợp lệ dựa vào startDate
      const { eligibleDays, joinedMidMonth, startDayInMonth, isBeforeJoined } = getEligibleDaysForEmployee(
        emp.startDate,
        targetYear,
        targetMonth,
        totalDaysInMonth
      );

      // Tính tổng số ngày nghỉ và số tiền bị khấu trừ (chỉ tính ngày nghỉ kể từ ngày bắt đầu làm)
      let leaveDays = 0;
      let currentLeaveDays = 0;
      if (emp.attendances && eligibleDays > 0) {
        emp.attendances.forEach((att) => {
          const attD = new Date(att.date);
          const attDay = attD.getDate();
          if (attDay >= startDayInMonth) {
            const count = (att.status === 'ABSENT' ? (att.shift === 'HALF' ? 0.5 : 1.0) : (att.status === 'PRESENT' && att.shift === 'HALF' ? 0.5 : 0));
            leaveDays += count;
            if (attDay <= currentDayCutoff) {
              currentLeaveDays += count;
            }
          }
        });
      }

      const workingDays = Math.max(0, eligibleDays - leaveDays);
      const leaveDeduction = Math.round(leaveDays * (baseSalary / totalDaysInMonth));

      let calculatedSalary = 0;
      if (eligibleDays > 0) {
        if (joinedMidMonth) {
          calculatedSalary = Math.max(0, Math.round((baseSalary / totalDaysInMonth) * workingDays));
        } else {
          calculatedSalary = Math.max(0, baseSalary - leaveDeduction);
        }
      }

      // Tính số công và lương tính đến ngày hiện tại
      let currentEligibleDays = 0;
      if (!isFutureMonth && !isBeforeJoined && currentDayCutoff >= startDayInMonth) {
        currentEligibleDays = Math.max(0, currentDayCutoff - startDayInMonth + 1);
      }
      const currentWorkingDays = Math.max(0, currentEligibleDays - currentLeaveDays);
      let currentSalary = 0;
      if (currentEligibleDays > 0) {
        currentSalary = Math.max(0, Math.round((baseSalary / totalDaysInMonth) * currentWorkingDays));
      }

      // Tạm ứng tính đến ngày hiện tại
      let currentAdvances = 0;
      if (emp.advances) {
        emp.advances.forEach((adv) => {
          const advD = new Date(adv.date);
          const advDay = advD.getDate();
          if (advDay <= currentDayCutoff) {
            currentAdvances += parseFloat(adv.amount);
          }
        });
      }
      
      // Lương tính đến ngày hiện tại sau khi trừ tạm ứng và trừ các đợt lương đã chi trả
      const currentRemainingSalary = Math.max(0, currentSalary - currentAdvances - totalPaidSalary);

      const carryOver = await calculateCarryOver(emp.id, baseSalary, targetMonthKey, emp.startDate);
      
      // Tổng lương thực lĩnh cả tháng (trước khi trừ tiền đã chi trả)
      const monthNetSalary = calculatedSalary - totalAdvances + carryOver;

      // Số tiền lương CÒN LẠI cần thanh toán sau khi trừ các đợt lương đã chi trả
      const remainingSalary = monthNetSalary - totalPaidSalary;

      // Trạng thái thanh toán:
      // - isPaid (đã trả đủ): khi đã có trả lương và số tiền còn lại <= 0
      // - isPartiallyPaid (đã trả 1 phần): khi đã trả nhưng vẫn còn tiền lương chưa trả hết
      const isPaid = totalPaidSalary > 0 && remainingSalary <= 0;
      const isPartiallyPaid = totalPaidSalary > 0 && remainingSalary > 0;
      const paidAt = emp.payments && emp.payments.length > 0 ? emp.payments[0].paidAt : null;

      // Chuẩn hóa danh sách chi tiết các lần tạm ứng trong tháng
      const formattedAdvances = (emp.advances || []).map((adv) => ({
        id: adv.id,
        amount: parseFloat(adv.amount),
        date: adv.date,
        note: adv.note || null,
      }));

      // Loại bỏ attendances và payments, giữ lại danh sách advances để tách từng lần ứng
      const { attendances, payments, ...rest } = emp;

      return {
        ...rest,
        advances: formattedAdvances,
        totalAdvances,
        totalPaidSalary,
        monthNetSalary,
        leaveDays,
        leaveDeduction,
        dailySalary,
        calculatedSalary,
        remainingSalary,
        carryOver,
        isPaid,
        isPartiallyPaid,
        paidAt,
        totalDaysInMonth,
        eligibleDays,
        workingDays,
        joinedMidMonth,
        startDayInMonth,
        startDayText: joinedMidMonth && startDayInMonth > 1
          ? `(từ ${startDayInMonth.toString().padStart(2, '0')}/${targetMonth.toString().padStart(2, '0')})`
          : '',
        isBeforeJoined,
        // Dữ liệu lũy kế tính đến ngày hiện tại
        currentDayCutoff,
        currentEligibleDays,
        currentLeaveDays,
        currentWorkingDays,
        currentSalary,
        currentAdvances,
        currentRemainingSalary,
        isCurrentMonth,
        isPastMonth,
        isFutureMonth,
      };
    }));

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// 2. Tạo mới nhân viên
const createEmployee = async (req, res, next) => {
  try {
    const { name, phone, address, role, baseSalary, startDate } = req.body;
    const userId = req.effectiveUserId;

    if (!name || name.trim() === '') {
      throw new BadRequestError('Tên nhân viên là thông tin bắt buộc.');
    }
    if (baseSalary === undefined || parseFloat(baseSalary) < 0) {
      throw new BadRequestError('Lương cơ bản không hợp lệ.');
    }

    let parsedStartDate = null;
    if (startDate) {
      const d = new Date(startDate);
      if (!isNaN(d.getTime())) {
        parsedStartDate = d;
      }
    }

    const employee = await prisma.employee.create({
      data: {
        userId,
        name: name.trim(),
        phone: phone ? phone.trim() : null,
        address: address ? address.trim() : null,
        role: role ? role.trim() : null,
        baseSalary: parseFloat(baseSalary),
        startDate: parsedStartDate,
      },
    });

    await logActivity(
      userId,
      'CREATE_EMPLOYEE',
      `Thêm nhân viên mới: ${employee.name} (Chức vụ: ${employee.role || 'Không'}, Lương: ${employee.baseSalary.toLocaleString('vi-VN')}đ${parsedStartDate ? `, Vào làm: ${parsedStartDate.toISOString().split('T')[0]}` : ''})`
    );

    res.status(201).json({
      success: true,
      data: employee,
    });
  } catch (error) {
    next(error);
  }
};

// 3. Cập nhật thông tin nhân viên
const updateEmployee = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, phone, address, role, baseSalary, startDate } = req.body;
    const userId = req.effectiveUserId;

    const employee = await prisma.employee.findFirst({
      where: { id, userId, isActive: true },
    });

    if (!employee) {
      throw new NotFoundError('Không tìm thấy nhân viên hoặc bạn không có quyền sửa.');
    }

    let parsedStartDate = undefined;
    if (startDate !== undefined) {
      if (startDate) {
        const d = new Date(startDate);
        if (!isNaN(d.getTime())) {
          parsedStartDate = d;
        }
      } else {
        parsedStartDate = null;
      }
    }

    const updated = await prisma.employee.update({
      where: { id },
      data: {
        name: name !== undefined ? name.trim() : undefined,
        phone: phone !== undefined ? (phone ? phone.trim() : null) : undefined,
        address: address !== undefined ? (address ? address.trim() : null) : undefined,
        role: role !== undefined ? (role ? role.trim() : null) : undefined,
        baseSalary: baseSalary !== undefined ? parseFloat(baseSalary) : undefined,
        startDate: parsedStartDate !== undefined ? parsedStartDate : undefined,
      },
    });

    await logActivity(
      userId,
      'UPDATE_EMPLOYEE',
      `Cập nhật nhân viên ${employee.name} -> ${updated.name} (Chức vụ: ${updated.role || 'Không'}, Lương: ${updated.baseSalary.toLocaleString('vi-VN')}đ)`
    );

    res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

// 4. Xóa mềm nhân viên
const deleteEmployee = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.effectiveUserId;

    const employee = await prisma.employee.findFirst({
      where: { id, userId, isActive: true },
    });

    if (!employee) {
      throw new NotFoundError('Không tìm thấy nhân viên hoặc bạn không có quyền xóa.');
    }

    await prisma.employee.update({
      where: { id },
      data: { isActive: false },
    });

    await logActivity(
      userId,
      'DELETE_EMPLOYEE',
      `Xóa nhân viên: ${employee.name}`
    );

    res.status(200).json({
      success: true,
      message: 'Xóa nhân viên thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 5. Lấy danh sách chấm công theo ngày
const getAttendances = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { date } = req.query; // Ngày truyền lên dạng "YYYY-MM-DD"

    if (!date) {
      throw new BadRequestError('date là tham số bắt buộc.');
    }

    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    // Lấy tất cả nhân viên của chủ sạp
    const employees = await prisma.employee.findMany({
      where: { userId, isActive: true },
      orderBy: { name: 'asc' },
    });

    // Lấy chấm công của các nhân viên này trong ngày được chọn
    const attendances = await prisma.attendance.findMany({
      where: {
        date: {
          gte: startOfDay,
          lte: endOfDay,
        },
        employee: {
          userId,
          isActive: true,
        },
      },
    });

    // Gom dữ liệu trả về: Mỗi nhân viên kèm trạng thái chấm công (nếu có)
    const result = employees.map((emp) => {
      const att = attendances.find((a) => a.employeeId === emp.id);
      return {
        employeeId: emp.id,
        name: emp.name,
        role: emp.role,
        hasAttendance: !!att,
        status: att ? att.status : 'PRESENT', // Mặc định tự động đi làm
        shift: att ? att.shift : 'FULL', // Mặc định đi làm cả ngày
        note: att ? att.note : '',
      };
    });

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// 6. Ghi nhận/Cập nhật chấm công hàng loạt trong ngày
const saveAttendance = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { date, list } = req.body; // list: [{ employeeId, status, shift, note }]

    if (!date || !list || !Array.isArray(list)) {
      throw new BadRequestError('Tham số date và list là bắt buộc.');
    }

    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);

    // Lưu từng dòng chấm công
    for (const item of list) {
      const { employeeId, status, shift, note } = item;

      // Xác minh nhân viên thuộc chủ sạp
      const emp = await prisma.employee.findFirst({
        where: { id: employeeId, userId, isActive: true },
      });

      if (!emp) continue;

      // Tìm chấm công đã có trong ngày
      const existing = await prisma.attendance.findFirst({
        where: {
          employeeId,
          date: {
            gte: new Date(targetDate.getTime()),
            lte: new Date(targetDate.getTime() + 24 * 60 * 60 * 1000 - 1),
          },
        },
      });

      if (existing) {
        // Cập nhật chấm công
        await prisma.attendance.update({
          where: { id: existing.id },
          data: {
            status,
            shift: status === 'PRESENT' ? shift : 'FULL', // Nếu nghỉ thì mặc định full ngày nghỉ
            note: note || null,
          },
        });
      } else {
        // Tạo mới chấm công
        await prisma.attendance.create({
          data: {
            employeeId,
            date: targetDate,
            status,
            shift: status === 'PRESENT' ? shift : 'FULL',
            note: note || null,
          },
        });
      }
    }

    await logActivity(
      userId,
      'SAVE_ATTENDANCE',
      `Cập nhật chấm công nhân viên ngày ${date}`
    );

    res.status(200).json({
      success: true,
      message: 'Lưu chấm công thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 7. Tạo khoản tạm ứng lương cho nhân viên
const createSalaryAdvance = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { employeeId, amount, note, date } = req.body;

    if (!employeeId || !amount || parseFloat(amount) <= 0) {
      throw new BadRequestError('employeeId và số tiền ứng hợp lệ là bắt buộc.');
    }

    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, userId, isActive: true },
    });

    if (!employee) {
      throw new NotFoundError('Không tìm thấy nhân viên.');
    }

    // 1. Xác định thời gian đầu tháng và cuối tháng của ngày tạm ứng
    const targetDate = date ? new Date(date) : new Date();
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth();
    const startOfMonth = new Date(year, month, 1);
    const endOfMonth = new Date(year, month + 1, 0, 23, 59, 59, 999);

    // 2. Tính tổng số tiền đã tạm ứng trong tháng này
    const existingAdvances = await prisma.salaryAdvance.findMany({
      where: {
        employeeId,
        date: {
          gte: startOfMonth,
          lte: endOfMonth,
        },
      },
    });

    const totalExistingAdvances = existingAdvances.reduce((sum, adv) => sum + parseFloat(adv.amount), 0);
    const newAmount = parseFloat(amount);
    const baseSalary = parseFloat(employee.baseSalary);

    // Cho phép tạm ứng vượt quá lương cơ bản tháng, số âm dư thừa sẽ được lũy kế chuyển sang tháng sau.

    const advance = await prisma.salaryAdvance.create({
      data: {
        employeeId,
        amount: newAmount,
        note: note ? note.trim() : null,
        date: targetDate,
      },
    });

    await logActivity(
      userId,
      'CREATE_SALARY_ADVANCE',
      `Tạm ứng lương cho nhân viên ${employee.name}: Số tiền ${newAmount.toLocaleString('vi-VN')}đ`
    );

    res.status(201).json({
      success: true,
      data: advance,
    });
  } catch (error) {
    next(error);
  }
};

// 8. Tính toán bảng lương dự kiến của một tháng
const calculateSalary = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { monthKey } = req.query; // Tháng tính lương, định dạng "MM/YYYY"

    if (!monthKey) {
      throw new BadRequestError('monthKey là bắt buộc.');
    }

    const dateParsed = parseMonthKey(monthKey);
    if (!dateParsed) {
      throw new BadRequestError('monthKey không đúng định dạng MM/YYYY.');
    }

    const { month, year } = dateParsed;
    const totalDaysInMonth = getDaysInMonth(year, month);

    // Xác định khoảng thời gian của tháng
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);

    // Lấy danh sách nhân viên
    const employees = await prisma.employee.findMany({
      where: { userId, isActive: true },
    });

    const result = [];

    for (const emp of employees) {
      // 1. Tính số ngày công hợp lệ dựa vào startDate
      const { eligibleDays, joinedMidMonth, startDayInMonth } = getEligibleDaysForEmployee(
        emp.startDate,
        year,
        month,
        totalDaysInMonth
      );

      let leaveDays = 0;
      attendances.forEach((att) => {
        const attD = new Date(att.date);
        const attDay = attD.getDate();
        if (attDay >= startDayInMonth) {
          if (att.status === 'ABSENT') {
            leaveDays += (att.shift === 'HALF' ? 0.5 : 1.0);
          } else if (att.status === 'PRESENT' && att.shift === 'HALF') {
            leaveDays += 0.5;
          }
        }
      });

      const workingDays = Math.max(0, eligibleDays - leaveDays);

      // 2. Tính lương 1 ngày và tổng lương thực tế đi làm
      const baseSalary = parseFloat(emp.baseSalary);
      const dailySalary = baseSalary / totalDaysInMonth;
      let calculatedSalary = 0;
      if (eligibleDays > 0) {
        if (joinedMidMonth) {
          calculatedSalary = Math.round(dailySalary * workingDays);
        } else {
          calculatedSalary = Math.max(0, baseSalary - Math.round(leaveDays * dailySalary));
        }
      }

      // 3. Tính tổng tiền đã tạm ứng trong tháng
      const advances = await prisma.salaryAdvance.findMany({
        where: {
          employeeId: emp.id,
          date: {
            gte: startOfMonth,
            lte: endOfMonth,
          },
        },
      });
      const totalAdvances = advances.reduce((sum, adv) => sum + parseFloat(adv.amount), 0);

      // 4. Kiểm tra xem tháng này đã chốt lương chưa
      const payment = await prisma.salaryPayment.findFirst({
        where: {
          employeeId: emp.id,
          monthKey,
        },
      });

      const finalAmount = Math.max(0, calculatedSalary - totalAdvances);

      // Lọc ra danh sách chi tiết các ngày nghỉ hoặc làm nửa ngày để đối soát dễ dàng
      const leaves = attendances
        .filter((att) => {
          const attD = new Date(att.date);
          return attD.getDate() >= startDayInMonth && (att.status === 'ABSENT' || (att.status === 'PRESENT' && att.shift === 'HALF'));
        })
        .map((att) => ({
          id: att.id,
          date: att.date.toISOString().split('T')[0],
          status: att.status,
          shift: att.shift,
          note: att.note || '',
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      result.push({
        employeeId: emp.id,
        name: emp.name,
        role: emp.role,
        baseSalary,
        totalDaysInMonth,
        eligibleDays,
        workingDays,
        joinedMidMonth,
        dailySalary: Math.round(dailySalary),
        calculatedSalary: Math.round(calculatedSalary),
        totalAdvances,
        finalAmount: Math.round(finalAmount),
        isPaid: !!payment,
        paidAt: payment ? payment.paidAt : null,
        leaves, // Danh sách ngày nghỉ làm để Frontend đối soát
      });
    }

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

// 8.5. Xem trước chi tiết tính lương theo khoảng ngày (preview salary by date range)
const previewSalary = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { employeeId, fromDate, toDate, monthKey } = req.query;

    if (!employeeId || !fromDate || !toDate) {
      throw new BadRequestError('employeeId, fromDate và toDate là bắt buộc.');
    }

    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, userId, isActive: true },
    });

    if (!employee) {
      throw new NotFoundError('Không tìm thấy nhân viên.');
    }

    const startOfFromDate = parseFlexibleDate(fromDate);
    if (startOfFromDate) startOfFromDate.setHours(0, 0, 0, 0);

    const endOfToDate = parseFlexibleDate(toDate);
    if (endOfToDate) endOfToDate.setHours(23, 59, 59, 999);

    if (isNaN(startOfFromDate.getTime()) || isNaN(endOfToDate.getTime())) {
      throw new BadRequestError('Định dạng ngày không hợp lệ.');
    }

    if (startOfFromDate > endOfToDate) {
      throw new BadRequestError('Từ ngày phải nhỏ hơn hoặc bằng Đến ngày.');
    }

    // Xác định số ngày trong tháng của kỳ lương
    const fromMonth = startOfFromDate.getMonth() + 1;
    const fromYear = startOfFromDate.getFullYear();
    const totalDaysInMonth = getDaysInMonth(fromYear, fromMonth);
    const resolvedMonthKey = monthKey || `${fromMonth.toString().padStart(2, '0')}/${fromYear}`;

    const baseSalary = parseFloat(employee.baseSalary);
    const dailySalary = baseSalary / totalDaysInMonth;

    // Xác định ngày bắt đầu tính công thực tế dựa vào startDate
    let effectiveStartDate = new Date(startOfFromDate.getTime());
    let joinedMidPeriod = false;
    if (employee.startDate) {
      const empStart = new Date(employee.startDate);
      empStart.setHours(0, 0, 0, 0);
      if (empStart > startOfFromDate) {
        effectiveStartDate = empStart;
        joinedMidPeriod = true;
      }
    }

    let eligibleDays = 0;
    if (effectiveStartDate <= endOfToDate) {
      const diffDays = Math.floor((endOfToDate.getTime() - effectiveStartDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
      eligibleDays = Math.max(0, diffDays);
    }

    // Chấm công và ngày nghỉ trong khoảng
    const attendances = await prisma.attendance.findMany({
      where: {
        employeeId,
        date: { gte: startOfFromDate, lte: endOfToDate },
      },
      orderBy: { date: 'asc' },
    });

    let leaveDays = 0;
    const leavesList = [];
    attendances.forEach((att) => {
      const attD = new Date(att.date);
      if (attD >= effectiveStartDate) {
        if (att.status === 'ABSENT') {
          const count = att.shift === 'HALF' ? 0.5 : 1.0;
          leaveDays += count;
          leavesList.push({
            id: att.id,
            date: att.date.toISOString().split('T')[0],
            shift: att.shift,
            note: att.note || '',
          });
        } else if (att.status === 'PRESENT' && att.shift === 'HALF') {
          leaveDays += 0.5;
          leavesList.push({
            id: att.id,
            date: att.date.toISOString().split('T')[0],
            shift: 'HALF',
            note: att.note || '',
          });
        }
      }
    });

    const workingDays = Math.max(0, eligibleDays - leaveDays);
    const calculatedSalary = Math.round(dailySalary * workingDays);

    // Tạm ứng trong khoảng ngày
    const advances = await prisma.salaryAdvance.findMany({
      where: {
        employeeId,
        date: { gte: startOfFromDate, lte: endOfToDate },
      },
      orderBy: { date: 'asc' },
    });
    const totalAdvances = advances.reduce((sum, adv) => sum + parseFloat(adv.amount), 0);

    // Kiểm tra các khoản lương đã thanh toán để cảnh báo trùng lặp khoảng ngày
    const paidPayments = await prisma.salaryPayment.findMany({
      where: {
        employeeId,
        status: 'PAID',
      },
    });

    let overlappedPayment = null;
    for (const p of paidPayments) {
      if (p.fromDate && p.toDate) {
        const pFrom = new Date(p.fromDate);
        const pTo = new Date(p.toDate);
        if (startOfFromDate <= pTo && endOfToDate >= pFrom) {
          overlappedPayment = p;
          break;
        }
      } else if (p.monthKey === resolvedMonthKey && !p.fromDate) {
        overlappedPayment = p;
        break;
      }
    }

    res.status(200).json({
      success: true,
      data: {
        employeeId,
        employeeName: employee.name,
        baseSalary,
        dailySalary: Math.round(dailySalary),
        totalDaysInMonth,
        monthKey: resolvedMonthKey,
        fromDate: startOfFromDate.toISOString().split('T')[0],
        toDate: endOfToDate.toISOString().split('T')[0],
        eligibleDays,
        leaveDays,
        workingDays,
        joinedMidPeriod,
        calculatedSalary,
        totalAdvances,
        advancesList: advances.map((a) => ({
          id: a.id,
          amount: parseFloat(a.amount),
          date: a.date.toISOString().split('T')[0],
          note: a.note || '',
        })),
        leavesList,
        suggestedFinalAmount: Math.max(0, calculatedSalary - totalAdvances),
        isOverlapped: !!overlappedPayment,
        overlappedPeriod: overlappedPayment
          ? (overlappedPayment.fromDate
              ? `${new Date(overlappedPayment.fromDate).toLocaleDateString('vi-VN')} - ${new Date(overlappedPayment.toDate).toLocaleDateString('vi-VN')}`
              : `Tháng ${overlappedPayment.monthKey}`)
          : null,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 9. Chốt và thanh toán lương (theo tháng hoặc khoảng ngày)
const paySalary = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { employeeId, monthKey, fromDate, toDate, bonus, deductions, note, amount } = req.body;

    if (!employeeId) {
      throw new BadRequestError('employeeId là bắt buộc.');
    }

    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, userId, isActive: true },
    });

    if (!employee) {
      throw new NotFoundError('Không tìm thấy nhân viên.');
    }

    const baseSalary = parseFloat(employee.baseSalary);
    const bonusVal = bonus ? parseFloat(bonus) : 0;
    const deductionsVal = deductions ? parseFloat(deductions) : 0;

    let startOfPeriod, endOfPeriod, resolvedMonthKey, totalDaysInMonth, dailySalary, workingDays, calculatedSalary, totalAdvances;

    if (fromDate && toDate) {
      // ─── Chi trả lương theo khoảng ngày lựa chọn ───
      startOfPeriod = parseFlexibleDate(fromDate);
      if (startOfPeriod) startOfPeriod.setHours(0, 0, 0, 0);

      endOfPeriod = parseFlexibleDate(toDate);
      if (endOfPeriod) endOfPeriod.setHours(23, 59, 59, 999);

      if (isNaN(startOfPeriod.getTime()) || isNaN(endOfPeriod.getTime())) {
        throw new BadRequestError('Định dạng khoảng ngày không hợp lệ.');
      }
      if (startOfPeriod > endOfPeriod) {
        throw new BadRequestError('Từ ngày phải nhỏ hơn hoặc bằng Đến ngày.');
      }

      const pMonth = startOfPeriod.getMonth() + 1;
      const pYear = startOfPeriod.getFullYear();
      totalDaysInMonth = getDaysInMonth(pYear, pMonth);
      resolvedMonthKey = monthKey || `${pMonth.toString().padStart(2, '0')}/${pYear}`;
      dailySalary = baseSalary / totalDaysInMonth;

      // Kiểm tra trùng lặp với các đợt lương đã chi trả
      const existingPayments = await prisma.salaryPayment.findMany({
        where: { employeeId, status: 'PAID' },
      });

      for (const ep of existingPayments) {
        if (ep.fromDate && ep.toDate) {
          const epFrom = new Date(ep.fromDate);
          const epTo = new Date(ep.toDate);
          if (startOfPeriod <= epTo && endOfPeriod >= epFrom) {
            const epFromStr = `${epFrom.getDate().toString().padStart(2, '0')}/${(epFrom.getMonth() + 1).toString().padStart(2, '0')}/${epFrom.getFullYear()}`;
            const epToStr = `${epTo.getDate().toString().padStart(2, '0')}/${(epTo.getMonth() + 1).toString().padStart(2, '0')}/${epTo.getFullYear()}`;
            throw new BadRequestError(`Khoảng ngày này bị trùng lặp với đợt lương đã chi trả trước đó (${epFromStr} - ${epToStr}).`);
          }
        }
      }

      let effectiveStartDate = new Date(startOfPeriod.getTime());
      if (employee.startDate) {
        const empStart = new Date(employee.startDate);
        empStart.setHours(0, 0, 0, 0);
        if (empStart > startOfPeriod) {
          effectiveStartDate = empStart;
        }
      }

      let eligibleDays = 0;
      if (effectiveStartDate <= endOfPeriod) {
        const diffDays = Math.floor((endOfPeriod.getTime() - effectiveStartDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
        eligibleDays = Math.max(0, diffDays);
      }

      const attendances = await prisma.attendance.findMany({
        where: {
          employeeId,
          date: { gte: startOfPeriod, lte: endOfPeriod },
        },
      });

      let leaveDays = 0;
      attendances.forEach((att) => {
        const attD = new Date(att.date);
        if (attD >= effectiveStartDate) {
          if (att.status === 'ABSENT') {
            leaveDays += (att.shift === 'HALF' ? 0.5 : 1.0);
          } else if (att.status === 'PRESENT' && att.shift === 'HALF') {
            leaveDays += 0.5;
          }
        }
      });

      workingDays = Math.max(0, eligibleDays - leaveDays);
      calculatedSalary = Math.round(dailySalary * workingDays);

      const advances = await prisma.salaryAdvance.findMany({
        where: {
          employeeId,
          date: { gte: startOfPeriod, lte: endOfPeriod },
        },
      });
      totalAdvances = advances.reduce((sum, adv) => sum + parseFloat(adv.amount), 0);

    } else {
      // ─── Chi trả lương trọn vẹn cả tháng (Nguyên bản) ───
      if (!monthKey) {
        throw new BadRequestError('monthKey là bắt buộc khi không chọn khoảng ngày.');
      }
      resolvedMonthKey = monthKey;

      const existingPayment = await prisma.salaryPayment.findFirst({
        where: { employeeId, monthKey: resolvedMonthKey },
      });
      if (existingPayment) {
        throw new BadRequestError('Tháng này đã được thanh toán lương cho nhân viên.');
      }

      const dateParsed = parseMonthKey(resolvedMonthKey);
      if (!dateParsed) {
        throw new BadRequestError('monthKey không hợp lệ.');
      }
      const { month, year } = dateParsed;
      totalDaysInMonth = getDaysInMonth(year, month);
      startOfPeriod = new Date(year, month - 1, 1);
      endOfPeriod = new Date(year, month, 0, 23, 59, 59, 999);
      dailySalary = baseSalary / totalDaysInMonth;

      const attendances = await prisma.attendance.findMany({
        where: {
          employeeId,
          date: { gte: startOfPeriod, lte: endOfPeriod },
        },
      });

      const { eligibleDays, joinedMidMonth, startDayInMonth } = getEligibleDaysForEmployee(
        employee.startDate,
        year,
        month,
        totalDaysInMonth
      );

      let leaveDays = 0;
      attendances.forEach((att) => {
        const attD = new Date(att.date);
        const attDay = attD.getDate();
        if (attDay >= startDayInMonth) {
          if (att.status === 'ABSENT') {
            leaveDays += (att.shift === 'HALF' ? 0.5 : 1.0);
          } else if (att.status === 'PRESENT' && att.shift === 'HALF') {
            leaveDays += 0.5;
          }
        }
      });

      workingDays = Math.max(0, eligibleDays - leaveDays);
      if (eligibleDays > 0) {
        if (joinedMidMonth) {
          calculatedSalary = Math.round(dailySalary * workingDays);
        } else {
          calculatedSalary = Math.max(0, baseSalary - Math.round(leaveDays * dailySalary));
        }
      } else {
        calculatedSalary = 0;
      }

      const advances = await prisma.salaryAdvance.findMany({
        where: {
          employeeId,
          date: { gte: startOfPeriod, lte: endOfPeriod },
        },
      });
      totalAdvances = advances.reduce((sum, adv) => sum + parseFloat(adv.amount), 0);
    }

    let finalAmount = Math.max(0, calculatedSalary - totalAdvances + bonusVal - deductionsVal);
    // Nếu có truyền trực tiếp số tiền chi trả lương mong muốn, ưu tiên lấy theo số tiền này
    if (amount !== undefined && amount !== null && !isNaN(parseFloat(amount))) {
      finalAmount = Math.max(0, parseFloat(amount));
    }

    const payment = await prisma.salaryPayment.create({
      data: {
        employeeId,
        monthKey: resolvedMonthKey,
        baseSalary,
        workingDays,
        advancesDeducted: totalAdvances,
        bonus: bonusVal,
        deductions: deductionsVal,
        finalAmount,
        fromDate: startOfPeriod,
        toDate: endOfPeriod,
        status: 'PAID',
        paidAt: new Date(),
        note: note ? note.trim() : null,
      },
    });

    const periodDesc = (fromDate && toDate)
      ? `${new Date(startOfPeriod).toLocaleDateString('vi-VN')} - ${new Date(endOfPeriod).toLocaleDateString('vi-VN')}`
      : `tháng ${resolvedMonthKey}`;

    await logActivity(
      userId,
      'PAY_SALARY',
      `Thanh toán chốt lương (${periodDesc}) cho nhân viên ${employee.name}: Thực lĩnh ${finalAmount.toLocaleString('vi-VN')}đ`
    );

    res.status(201).json({
      success: true,
      data: payment,
    });
  } catch (error) {
    next(error);
  }
};

// 10. Lấy lịch sử tổng hợp của một nhân viên (Chấm công, ứng lương, trả lương)
const getEmployeeHistory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.effectiveUserId;

    const employee = await prisma.employee.findFirst({
      where: { id, userId, isActive: true },
    });

    if (!employee) {
      throw new NotFoundError('Không tìm thấy nhân viên.');
    }

    // Lấy chấm công 3 tháng gần nhất
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const attendances = await prisma.attendance.findMany({
      where: {
        employeeId: id,
        date: { gte: threeMonthsAgo },
      },
      orderBy: { date: 'desc' },
    });

    // Lấy tạm ứng lương
    const advances = await prisma.salaryAdvance.findMany({
      where: { employeeId: id },
      orderBy: { date: 'desc' },
    });

    // Lấy lịch sử thanh toán lương tháng
    const payments = await prisma.salaryPayment.findMany({
      where: { employeeId: id },
      orderBy: { monthKey: 'desc' },
    });

    res.status(200).json({
      success: true,
      data: {
        attendances,
        advances,
        payments,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 11. Tạo đường dẫn tra cứu Lương, Chế độ và Ngày nghỉ gửi qua Zalo cho nhân viên
const getEmployeeShareLink = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.effectiveUserId;

    const employee = await prisma.employee.findFirst({
      where: { id, userId, isActive: true },
      include: {
        user: {
          select: { id: true, name: true, phone: true }
        }
      }
    });

    if (!employee) {
      throw new NotFoundError('Không tìm thấy nhân viên.');
    }

    // Tạo token mã hóa chứa thông tin nhân viên
    const token = jwt.sign(
      {
        employeeId: employee.id,
        userId: employee.userId,
        type: 'EMPLOYEE_SALARY',
      },
      PORTAL_SESSION_SECRET,
      { expiresIn: '365d' }
    );

    const cleanPhone = (employee.phone || '').replace(/[^0-9]/g, '');
    const suggestedPin = cleanPhone.length >= 4 ? cleanPhone.slice(-4) : null;

    res.status(200).json({
      success: true,
      data: {
        token,
        employeeId: employee.id,
        name: employee.name,
        phone: employee.phone,
        role: employee.role,
        suggestedPin,
        merchantName: employee.user?.name || 'Cửa hàng',
      },
    });
  } catch (error) {
    next(error);
  }
};

// 12. Ghi nhận nhân viên xin nghỉ và tự động trừ buổi lương
const recordLeave = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { employeeId, date, shift = 'FULL', note } = req.body;

    if (!employeeId || !date) {
      throw new BadRequestError('employeeId và date là bắt buộc.');
    }

    const emp = await prisma.employee.findFirst({
      where: { id: employeeId, userId, isActive: true },
    });

    if (!emp) {
      throw new NotFoundError('Không tìm thấy nhân viên.');
    }

    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);

    const existing = await prisma.attendance.findFirst({
      where: {
        employeeId,
        date: {
          gte: new Date(targetDate.getTime()),
          lte: new Date(targetDate.getTime() + 24 * 60 * 60 * 1000 - 1),
        },
      },
    });

    let leaveRecord;
    const shiftVal = shift === 'HALF' ? 'HALF' : 'FULL';

    if (existing) {
      leaveRecord = await prisma.attendance.update({
        where: { id: existing.id },
        data: {
          status: 'ABSENT',
          shift: shiftVal,
          note: note ? note.trim() : null,
        },
      });
    } else {
      leaveRecord = await prisma.attendance.create({
        data: {
          employeeId,
          date: targetDate,
          status: 'ABSENT',
          shift: shiftVal,
          note: note ? note.trim() : null,
        },
      });
    }

    const dateStr = targetDate.toISOString().split('T')[0];
    await logActivity(
      userId,
      'RECORD_EMPLOYEE_LEAVE',
      `Ghi nhận xin nghỉ: Nhân viên ${emp.name}, ngày ${dateStr}, ca ${shiftVal === 'HALF' ? 'Nửa ngày (0.5 buổi)' : 'Cả ngày (1 buổi)'}${note ? ` - Lý do: ${note}` : ''}`
    );

    res.status(200).json({
      success: true,
      data: leaveRecord,
      message: 'Ghi nhận xin nghỉ thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 13. Xóa bản ghi xin nghỉ
const deleteLeave = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;

    const leave = await prisma.attendance.findUnique({
      where: { id },
      include: { employee: true },
    });

    if (!leave || leave.employee.userId !== userId) {
      throw new NotFoundError('Không tìm thấy bản ghi nghỉ phép hoặc bạn không có quyền xóa.');
    }

    await prisma.attendance.delete({
      where: { id },
    });

    await logActivity(
      userId,
      'DELETE_EMPLOYEE_LEAVE',
      `Xóa bản ghi xin nghỉ của nhân viên ${leave.employee.name} ngày ${leave.date.toISOString().split('T')[0]}`
    );

    res.status(200).json({
      success: true,
      message: 'Đã xóa bản ghi nghỉ phép thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 14. Tạo đường dẫn chung cho toàn bộ nhân sự (tra cứu lương cá nhân & xem nội quy quy định cửa hàng)
const getGeneralEmployeeShareLink = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, phone: true },
    });

    if (!user) {
      throw new NotFoundError('Không tìm thấy thông tin cửa hàng.');
    }

    const totalEmployees = await prisma.employee.count({
      where: { userId, isActive: true },
    });

    // Tạo token chung cho cửa hàng/chủ buôn
    const token = jwt.sign(
      {
        userId,
        type: 'STAFF_PORTAL',
      },
      PORTAL_SESSION_SECRET,
      { expiresIn: '365d' }
    );

    res.status(200).json({
      success: true,
      data: {
        token,
        merchantName: user.name || 'Cửa hàng',
        totalEmployees,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getEligibleDaysForEmployee,
  getEmployees,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  getAttendances,
  saveAttendance,
  recordLeave,
  deleteLeave,
  createSalaryAdvance,
  calculateSalary,
  previewSalary,
  paySalary,
  getEmployeeHistory,
  getEmployeeShareLink,
  getGeneralEmployeeShareLink,
};
