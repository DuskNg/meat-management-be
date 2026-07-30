// meat-management-be/src/controllers/auth.js
const jwt = require('jsonwebtoken');
const prisma = require('../utils/db');
const { BadRequestError, UnauthorizedError, NotFoundError, ConflictError } = require('../utils/errors');
const esmsService = require('../services/esms.service');
const bcrypt = require('bcryptjs');

// Giữ nguyên các hàm requestOtp, verifyOtp, refreshToken, logout ở phía trên...
// (sẽ chỉ sửa phần từ dòng 200 trở đi và phần import ở đầu)


// 1. Đăng nhập trực tiếp bằng SĐT (Tạm thời bỏ qua xác thực OTP)
const requestOtp = async (req, res, next) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      throw new BadRequestError('Số điện thoại là bắt buộc.');
    }

    // Kiểm tra định dạng số điện thoại di động Việt Nam hợp lệ
    const phoneRegex = /^(0|84|\+84)[35789][0-9]{8}$/;
    const trimmedPhone = phone.trim();
    if (!phoneRegex.test(trimmedPhone)) {
      throw new BadRequestError('Số điện thoại không đúng định dạng Việt Nam.');
    }

    // Tìm xem số điện thoại đã có tài khoản chủ buôn chưa
    let user = await prisma.user.findUnique({
      where: { phone: trimmedPhone },
    });

    // Nếu chưa có, tiến hành tự động đăng ký mới tài khoản chủ buôn
    if (!user) {
      user = await prisma.user.create({
        data: {
          phone: trimmedPhone,
          name: 'Chủ buôn mới',
        },
      });
      console.log(`[AUTH] Tự động tạo tài khoản chủ buôn mới qua luồng SĐT trực tiếp: ${trimmedPhone}`);
    }

    // Định nghĩa các Secret Key cho Tokens
    const accessSecret = process.env.JWT_ACCESS_SECRET || 'default_access_secret';
    const refreshSecret = process.env.JWT_REFRESH_SECRET || 'default_refresh_secret';

    // Tạo Access Token (Hạn dùng 7 ngày)
    const accessToken = jwt.sign(
      { id: user.id, phone: user.phone },
      accessSecret,
      { expiresIn: '7d' }
    );

    // Tạo Refresh Token (Hạn dùng 30 ngày)
    const refreshToken = jwt.sign(
      { id: user.id },
      refreshSecret,
      { expiresIn: '30d' }
    );

    // Trả về trực tiếp thông tin đăng nhập thành công cho client
    res.status(200).json({
      success: true,
      message: 'Đăng nhập thành công bằng số điện thoại.',
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        hasPin: !!user.pin,
        isAdmin: user.isAdmin,
        permissions: {
          canManageCustomers: user.canManageCustomers,
          canManageDebt: user.canManageDebt,
          canManageBadDebt: user.canManageBadDebt,
          canManageEmployees: user.canManageEmployees,
          canManageStore: user.canManageStore,
        },
      },
      tokens: {
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 2. Xác thực mã OTP và đăng nhập/đăng ký
const verifyOtp = async (req, res, next) => {
  try {
    const { phone, code, name } = req.body;

    if (!phone || !code) {
      throw new BadRequestError('Số điện thoại và mã OTP là bắt buộc.');
    }

    // Kiểm tra mã OTP mới nhất, chưa sử dụng và chưa hết hạn
    const validOtp = await prisma.oTP.findFirst({
      where: {
        phone,
        code,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!validOtp) {
      throw new BadRequestError('Mã OTP không chính xác hoặc đã hết hạn.');
    }

    // Đánh dấu mã OTP đã được sử dụng
    await prisma.oTP.update({
      where: { id: validOtp.id },
      data: { usedAt: new Date() },
    });

    // Tìm xem số điện thoại đã có tài khoản chủ buôn chưa
    let user = await prisma.user.findUnique({
      where: { phone },
    });

    // Nếu chưa có, tiến hành đăng ký mới tài khoản chủ buôn
    if (!user) {
      user = await prisma.user.create({
        data: {
          phone,
          name: name || 'Chủ buôn mới',
        },
      });
      console.log(`[AUTH] Đã tự động tạo tài khoản chủ buôn mới cho SĐT: ${phone}`);
    }

    // Định nghĩa các Secret Key cho Tokens
    const accessSecret = process.env.JWT_ACCESS_SECRET || 'default_access_secret';
    const refreshSecret = process.env.JWT_REFRESH_SECRET || 'default_refresh_secret';

    // Tạo Access Token (Hạn dùng 7 ngày)
    const accessToken = jwt.sign(
      { id: user.id, phone: user.phone },
      accessSecret,
      { expiresIn: '7d' }
    );

    // Tạo Refresh Token (Hạn dùng 30 ngày)
    const refreshToken = jwt.sign(
      { id: user.id },
      refreshSecret,
      { expiresIn: '30d' }
    );

    res.status(200).json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        hasPin: !!user.pin,
        isAdmin: user.isAdmin,
        permissions: {
          canManageCustomers: user.canManageCustomers,
          canManageDebt: user.canManageDebt,
          canManageBadDebt: user.canManageBadDebt,
          canManageEmployees: user.canManageEmployees,
          canManageStore: user.canManageStore,
        },
      },
      tokens: {
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 3. Làm mới Access Token từ Refresh Token
const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      throw new BadRequestError('Refresh Token là bắt buộc.');
    }

    const refreshSecret = process.env.JWT_REFRESH_SECRET || 'default_refresh_secret';
    const accessSecret = process.env.JWT_ACCESS_SECRET || 'default_access_secret';

    // Xác thực Refresh Token
    jwt.verify(refreshToken, refreshSecret, async (err, decoded) => {
      if (err) {
        return next(new UnauthorizedError('Refresh Token không hợp lệ hoặc đã hết hạn.'));
      }

      // Kiểm tra người dùng có còn tồn tại trong cơ sở dữ liệu không
      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
      });

      if (!user) {
        return next(new UnauthorizedError('Tài khoản người dùng không tồn tại.'));
      }

      // Tạo cặp Access Token và Refresh Token mới
      const newAccessToken = jwt.sign(
        { id: user.id, phone: user.phone },
        accessSecret,
        { expiresIn: '7d' }
      );

      const newRefreshToken = jwt.sign(
        { id: user.id },
        refreshSecret,
        { expiresIn: '30d' }
      );

      res.status(200).json({
        success: true,
        tokens: {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
        },
      });
    });
  } catch (error) {
    next(error);
  }
};

// 4. Đăng xuất
const logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      throw new BadRequestError('Refresh Token là bắt buộc để đăng xuất.');
    }

    // Với cơ chế stateless JWT, client chỉ cần hủy token phía client (expo-secure-store).
    // Ở backend, ta trả về thành công để thông báo đăng xuất hoàn tất.
    res.status(200).json({
      success: true,
      message: 'Đăng xuất thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 5. Lấy thông tin hồ sơ chủ buôn
const getProfile = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        phone: true,
        pin: true,
        isAdmin: true,
        canManageCustomers: true,
        canManageDebt: true,
        canManageBadDebt: true,
        canManageEmployees: true,
        canManageStore: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new NotFoundError('Không tìm thấy tài khoản chủ buôn.');
    }

    res.status(200).json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        hasPin: !!user.pin,
        isAdmin: user.isAdmin,
        permissions: {
          canManageCustomers: user.canManageCustomers,
          canManageDebt: user.canManageDebt,
          canManageBadDebt: user.canManageBadDebt,
          canManageEmployees: user.canManageEmployees,
          canManageStore: user.canManageStore,
        },
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 6. Cập nhật thông tin hồ sơ và số điện thoại chủ buôn
const updateProfile = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { name, phone } = req.body;

    if (!name || name.trim() === '') {
      throw new BadRequestError('Tên chủ buôn không được để trống.');
    }

    if (!phone || phone.trim() === '') {
      throw new BadRequestError('Số điện thoại không được để trống.');
    }

    // Kiểm tra định dạng số điện thoại di động Việt Nam hợp lệ
    const phoneRegex = /^(0|84|\+84)[35789][0-9]{8}$/;
    if (!phoneRegex.test(phone.trim())) {
      throw new BadRequestError('Số điện thoại không đúng định dạng Việt Nam.');
    }

    const trimmedPhone = phone.trim();

    // Kiểm tra xem số điện thoại mới đã được đăng ký bởi người khác chưa
    const existingUser = await prisma.user.findFirst({
      where: {
        phone: trimmedPhone,
        id: { not: userId },
      },
    });

    if (existingUser) {
      throw new ConflictError('Số điện thoại này đã được sử dụng bởi một tài khoản khác.');
    }

    // Tiến hành cập nhật thông tin
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        name: name.trim(),
        phone: trimmedPhone,
      },
    });

    // Tạo lại tokens mới với thông tin số điện thoại đã được cập nhật
    const accessSecret = process.env.JWT_ACCESS_SECRET || 'default_access_secret';
    const refreshSecret = process.env.JWT_REFRESH_SECRET || 'default_refresh_secret';

    const accessToken = jwt.sign(
      { id: updatedUser.id, phone: updatedUser.phone },
      accessSecret,
      { expiresIn: '7d' }
    );

    const refreshToken = jwt.sign(
      { id: updatedUser.id },
      refreshSecret,
      { expiresIn: '30d' }
    );

    res.status(200).json({
      success: true,
      message: 'Cập nhật thông tin hồ sơ thành công.',
      user: {
        id: updatedUser.id,
        name: updatedUser.name,
        phone: updatedUser.phone,
        hasPin: !!updatedUser.pin,
        createdAt: updatedUser.createdAt,
      },
      tokens: {
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 7. Thiết lập hoặc thay đổi mã PIN mới
const setupPin = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { pin } = req.body;

    if (!pin) {
      throw new BadRequestError('Mã PIN là bắt buộc.');
    }

    // Kiểm tra định dạng mã PIN (phải là 4 chữ số)
    const pinRegex = /^[0-9]{4}$/;
    if (!pinRegex.test(pin)) {
      throw new BadRequestError('Mã PIN phải bao gồm đúng 4 chữ số.');
    }

    // Băm mã PIN bằng bcryptjs
    const bcrypt = require('bcryptjs');
    const hashedPin = await bcrypt.hash(pin, 10);

    // Cập nhật mã PIN cho người dùng
    await prisma.user.update({
      where: { id: userId },
      data: { pin: hashedPin },
    });

    res.status(200).json({
      success: true,
      message: 'Thiết lập mã PIN thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 8. Xác minh mã PIN của người dùng
const verifyPin = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { pin } = req.body;

    if (!pin) {
      throw new BadRequestError('Mã PIN là bắt buộc.');
    }

    // Tìm người dùng trong cơ sở dữ liệu
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundError('Không tìm thấy tài khoản người dùng.');
    }

    if (!user.pin) {
      throw new BadRequestError('Tài khoản chưa thiết lập mã PIN.');
    }

    // So sánh mã PIN bằng bcryptjs
    const bcrypt = require('bcryptjs');
    const isMatch = await bcrypt.compare(pin, user.pin);

    if (!isMatch) {
      return res.status(200).json({
        success: false,
        message: 'Mã PIN không chính xác.',
      });
    }

    res.status(200).json({
      success: true,
      message: 'Xác minh mã PIN thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 9. Xóa mã PIN của người dùng
const clearPin = async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Cập nhật trường pin về null trong cơ sở dữ liệu
    await prisma.user.update({
      where: { id: userId },
      data: { pin: null },
    });

    res.status(200).json({
      success: true,
      message: 'Xóa mã PIN thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 10. Đăng nhập Admin bằng SĐT & Mật khẩu
const adminLogin = async (req, res, next) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      throw new BadRequestError('Tài khoản (SĐT) và mật khẩu là bắt buộc.');
    }

    const user = await prisma.user.findUnique({
      where: { phone: phone.trim() },
    });

    if (!user || !user.isAdmin) {
      throw new UnauthorizedError('Tài khoản Admin không tồn tại hoặc không có quyền.');
    }

    const isMatch = await bcrypt.compare(password, user.password || '');
    if (!isMatch) {
      throw new UnauthorizedError('Mật khẩu không chính xác.');
    }

    // Định nghĩa Secrets cho JWT
    const accessSecret = process.env.JWT_ACCESS_SECRET || 'default_access_secret';
    const refreshSecret = process.env.JWT_REFRESH_SECRET || 'default_refresh_secret';

    // Tạo Access Token
    const accessToken = jwt.sign(
      { id: user.id, phone: user.phone, isAdmin: true },
      accessSecret,
      { expiresIn: '7d' }
    );

    // Tạo Refresh Token
    const refreshToken = jwt.sign(
      { id: user.id },
      refreshSecret,
      { expiresIn: '30d' }
    );

    res.status(200).json({
      success: true,
      message: 'Đăng nhập Admin thành công.',
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        isAdmin: true,
      },
      tokens: {
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  requestOtp,
  verifyOtp,
  refreshToken,
  logout,
  getProfile,
  updateProfile,
  setupPin,
  verifyPin,
  clearPin,
  adminLogin,
};

// Cập nhật cấu hình để nodemon tự động khởi động lại và nhận Prisma Client mới
