// meat-management-be/src/controllers/auth.js
const jwt = require('jsonwebtoken');
const prisma = require('../utils/db');
const { BadRequestError, UnauthorizedError } = require('../utils/errors');
const esmsService = require('../services/esms.service');

// 1. Yêu cầu gửi mã OTP
const requestOtp = async (req, res, next) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      throw new BadRequestError('Số điện thoại là bắt buộc.');
    }

    // Kiểm tra giới hạn: tối đa 3 lần gửi OTP trong vòng 10 phút
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const otpCount = await prisma.oTP.count({
      where: {
        phone,
        createdAt: { gte: tenMinutesAgo },
      },
    });

    if (otpCount >= 3) {
      throw new BadRequestError('Bạn đã gửi OTP quá 3 lần. Vui lòng thử lại sau 10 phút.', 'LIMIT_EXCEEDED');
    }

    // Sinh mã OTP ngẫu nhiên gồm 4 chữ số
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // Hết hạn sau 5 phút

    // Lưu mã OTP vào cơ sở dữ liệu
    await prisma.oTP.create({
      data: {
        phone,
        code,
        expiresAt,
      },
    });

    // Gửi OTP qua dịch vụ tin nhắn (Hỗ trợ Mock và Auto Fallback)
    const smsResult = await esmsService.sendOtp(phone, code);
 
    res.status(200).json({
      success: true,
      message: 'Mã OTP đã được gửi thành công.',
      debug: {
        mode: smsResult.mode,
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

module.exports = {
  requestOtp,
  verifyOtp,
  refreshToken,
  logout,
};
