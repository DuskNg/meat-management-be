// meat-management-be/src/controllers/employee.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError } = require('../utils/errors');

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

// 1. Lấy toàn bộ danh sách nhân viên
const getEmployees = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const employees = await prisma.employee.findMany({
      where: {
        userId,
        isActive: true,
      },
      orderBy: {
        name: 'asc',
      },
    });

    res.status(200).json({
      success: true,
      data: employees,
    });
  } catch (error) {
    next(error);
  }
};

// 2. Tạo mới nhân viên
const createEmployee = async (req, res, next) => {
  try {
    const { name, phone, address, role, baseSalary } = req.body;
    const userId = req.user.id;

    if (!name || name.trim() === '') {
      throw new BadRequestError('Tên nhân viên là thông tin bắt buộc.');
    }
    if (baseSalary === undefined || parseFloat(baseSalary) < 0) {
      throw new BadRequestError('Lương cơ bản không hợp lệ.');
    }

    const employee = await prisma.employee.create({
      data: {
        userId,
        name: name.trim(),
        phone: phone ? phone.trim() : null,
        address: address ? address.trim() : null,
        role: role ? role.trim() : null,
        baseSalary: parseFloat(baseSalary),
      },
    });

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
    const { name, phone, address, role, baseSalary } = req.body;
    const userId = req.user.id;

    const employee = await prisma.employee.findFirst({
      where: { id, userId, isActive: true },
    });

    if (!employee) {
      throw new NotFoundError('Không tìm thấy nhân viên hoặc bạn không có quyền sửa.');
    }

    const updated = await prisma.employee.update({
      where: { id },
      data: {
        name: name !== undefined ? name.trim() : undefined,
        phone: phone !== undefined ? (phone ? phone.trim() : null) : undefined,
        address: address !== undefined ? (address ? address.trim() : null) : undefined,
        role: role !== undefined ? (role ? role.trim() : null) : undefined,
        baseSalary: baseSalary !== undefined ? parseFloat(baseSalary) : undefined,
      },
    });

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
    const userId = req.user.id;

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
    const userId = req.user.id;
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
    const userId = req.user.id;
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
    const userId = req.user.id;
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

    // 3. Validate không cho phép tổng tiền ứng vượt quá lương cơ bản tháng
    if (totalExistingAdvances + newAmount > baseSalary) {
      const remaining = Math.max(0, baseSalary - totalExistingAdvances);
      const fmt = (val) => new Intl.NumberFormat('vi-VN').format(val) + 'đ';
      throw new BadRequestError(
        `Không thể tạm ứng! Nhân viên đã ứng ${fmt(totalExistingAdvances)} trong tháng. Hạn mức ứng tối đa còn lại là ${fmt(remaining)} (Lương cơ bản: ${fmt(baseSalary)}).`
      );
    }

    const advance = await prisma.salaryAdvance.create({
      data: {
        employeeId,
        amount: newAmount,
        note: note ? note.trim() : null,
        date: targetDate,
      },
    });

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
    const userId = req.user.id;
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
      // 1. Tính số ngày công thực tế từ bảng chấm công trong tháng
      const attendances = await prisma.attendance.findMany({
        where: {
          employeeId: emp.id,
          date: {
            gte: startOfMonth,
            lte: endOfMonth,
          },
        },
      });

      let workingDays = totalDaysInMonth; // Mặc định đi làm đủ cả tháng
      attendances.forEach((att) => {
        if (att.status === 'ABSENT') {
          workingDays -= 1.0; // Nghỉ phép trừ 1 công
        } else if (att.status === 'PRESENT' && att.shift === 'HALF') {
          workingDays -= 0.5; // Đi làm nửa ngày trừ 0.5 công
        }
      });

      // 2. Tính lương 1 ngày và tổng lương thực tế đi làm
      const baseSalary = parseFloat(emp.baseSalary);
      const dailySalary = baseSalary / totalDaysInMonth;
      const calculatedSalary = dailySalary * workingDays;

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
        .filter((att) => att.status === 'ABSENT' || (att.status === 'PRESENT' && att.shift === 'HALF'))
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
        workingDays,
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

// 9. Chốt và thanh toán lương tháng
const paySalary = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { employeeId, monthKey, bonus, deductions, note } = req.body;

    if (!employeeId || !monthKey) {
      throw new BadRequestError('employeeId và monthKey là bắt buộc.');
    }

    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, userId, isActive: true },
    });

    if (!employee) {
      throw new NotFoundError('Không tìm thấy nhân viên.');
    }

    // Kiểm tra xem tháng này đã trả lương chưa
    const existingPayment = await prisma.salaryPayment.findFirst({
      where: { employeeId, monthKey },
    });

    if (existingPayment) {
      throw new BadRequestError('Tháng này đã được thanh toán lương cho nhân viên.');
    }

    const dateParsed = parseMonthKey(monthKey);
    const { month, year } = dateParsed;
    const totalDaysInMonth = getDaysInMonth(year, month);
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);

    // Tính toán lại các chỉ số giống calculateSalary
    const attendances = await prisma.attendance.findMany({
      where: {
        employeeId,
        date: { gte: startOfMonth, lte: endOfMonth },
      },
    });

    let workingDays = totalDaysInMonth; // Mặc định đi làm đủ cả tháng
    attendances.forEach((att) => {
      if (att.status === 'ABSENT') {
        workingDays -= 1.0; // Nghỉ phép trừ 1 công
      } else if (att.status === 'PRESENT' && att.shift === 'HALF') {
        workingDays -= 0.5; // Đi làm nửa ngày trừ 0.5 công
      }
    });

    const baseSalary = parseFloat(employee.baseSalary);
    const dailySalary = baseSalary / totalDaysInMonth;
    const calculatedSalary = dailySalary * workingDays;

    const advances = await prisma.salaryAdvance.findMany({
      where: {
        employeeId,
        date: { gte: startOfMonth, lte: endOfMonth },
      },
    });
    const totalAdvances = advances.reduce((sum, adv) => sum + parseFloat(adv.amount), 0);

    const bonusVal = bonus ? parseFloat(bonus) : 0;
    const deductionsVal = deductions ? parseFloat(deductions) : 0;
    const finalAmount = Math.max(0, calculatedSalary - totalAdvances + bonusVal - deductionsVal);

    const payment = await prisma.salaryPayment.create({
      data: {
        employeeId,
        monthKey,
        baseSalary,
        workingDays,
        advancesDeducted: totalAdvances,
        bonus: bonusVal,
        deductions: deductionsVal,
        finalAmount,
        status: 'PAID',
        paidAt: new Date(),
        note: note ? note.trim() : null,
      },
    });

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
    const userId = req.user.id;

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

module.exports = {
  getEmployees,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  getAttendances,
  saveAttendance,
  createSalaryAdvance,
  calculateSalary,
  paySalary,
  getEmployeeHistory,
};
