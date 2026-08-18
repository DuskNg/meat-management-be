// meat-management-be/src/utils/socket.js
const { Server } = require('socket.io');

let io = null;

// Map lưu tất cả active resource locks: key = `${workspaceId}_${type}_${resourceId}`
// value = { type, resourceId, workspaceId, socketId, userId, userName, userColor, lockedAt }
const activeLocks = new Map();

// Map lưu bộ đếm timeout: lockKey -> setTimeout reference để tự động mở khóa cứng (Hard Timeout)
const lockTimeouts = new Map();

// Map ngược: socketId → Set các lock keys do socket đó đang giữ (để cleanup khi disconnect)
const socketLockKeys = new Map();

// Tạo màu avatar unique từ userId (dùng hash đơn giản)
const getUserColor = (userId) => {
  const colors = ['#E74C3C', '#E67E22', '#F1C40F', '#2ECC71', '#1ABC9C', '#3498DB', '#9B59B6', '#E91E63'];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
};

// Khởi tạo Socket.IO instance và liên kết với HTTP Server
const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: '*', // Cho phép kết nối từ cả Web, Expo và Mobile App
      methods: ['GET', 'POST'],
      credentials: false, // Bắt buộc false khi dùng origin: '*' để tránh lỗi CORS
    },
    allowEIO3: true, // Hỗ trợ Socket.IO phiên bản cũ hơn nếu có
    transports: ['polling', 'websocket'], // Cho phép cả polling và websocket
  });

  io.on('connection', (socket) => {
    console.log(`[SOCKET] Client connected: ${socket.id}`);

    // Khi client kết nối và gửi yêu cầu tham gia room workspace/cửa hàng
    socket.on('join_workspace', (workspaceId) => {
      console.log(`[SOCKET] Client ${socket.id} joined workspace_${workspaceId}`);
      if (workspaceId) {
        socket.join(`workspace_${workspaceId}`);

        // Gửi danh sách locks hiện tại cho client mới join (để sync trạng thái)
        const currentLocks = [];
        for (const [, lockInfo] of activeLocks) {
          if (lockInfo.workspaceId === workspaceId) {
            currentLocks.push(lockInfo);
          }
        }
        if (currentLocks.length > 0) {
          // Gửi đồng thời cả hai sự kiện (số ít và số nhiều) để đảm bảo tương thích
          socket.emit('RESOURCE_LOCKS_SYNC', { locks: currentLocks });
          socket.emit('RESOURCE_LOCK_SYNC', { locks: currentLocks });
        }
      }
    });

    // Khi client rời room
    socket.on('leave_workspace', (workspaceId) => {
      console.log(`[SOCKET] Client ${socket.id} left workspace_${workspaceId}`);
      if (workspaceId) {
        socket.leave(`workspace_${workspaceId}`);
      }
    });

    // Khi người dùng bắt đầu thao tác với một đối tượng (mở modal)
    socket.on('lock_resource', ({ type, resourceId, workspaceId, userId, userName }) => {
      if (!type || !resourceId || !workspaceId || !userId) return;

      const lockKey = `${workspaceId}_${type}_${resourceId}`;
      const lockInfo = {
        type,
        resourceId,
        workspaceId,
        socketId: socket.id,
        userId,
        userName: userName || 'Người dùng',
        userColor: getUserColor(userId),
        lockedAt: new Date().toISOString(),
      };

      // Lưu lock vào Map chính
      activeLocks.set(lockKey, lockInfo);

      // Lưu vào Map ngược để cleanup khi disconnect
      if (!socketLockKeys.has(socket.id)) {
        socketLockKeys.set(socket.id, new Set());
      }
      socketLockKeys.get(socket.id).add(lockKey);

      console.log(`[SOCKET] Resource locked: ${lockKey} by ${userName} (${socket.id})`);

      // Xóa timeout cũ nếu có
      const existingTimeout = lockTimeouts.get(lockKey);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      // Thiết lập Hard Timeout (3 phút = 180000ms) để tự giải phóng khóa
      const timeoutRef = setTimeout(() => {
        if (activeLocks.has(lockKey)) {
          const info = activeLocks.get(lockKey);
          activeLocks.delete(lockKey);
          lockTimeouts.delete(lockKey);
          socketLockKeys.get(info.socketId)?.delete(lockKey);

          console.log(`[SOCKET] Hard Lock Timeout released: ${lockKey}`);

          // Phát sự kiện TIMEOUT_UNLOCKED để báo cho client
          io.to(`workspace_${workspaceId}`).emit('RESOURCE_LOCK_CHANGED', {
            action: 'TIMEOUT_UNLOCKED',
            lockInfo: info,
          });
        }
      }, 180000);

      lockTimeouts.set(lockKey, timeoutRef);

      // Broadcast tới tất cả client trong workspace room
      io.to(`workspace_${workspaceId}`).emit('RESOURCE_LOCK_CHANGED', {
        action: 'LOCKED',
        lockInfo,
      });
    });

    // Khi người dùng kết thúc thao tác (đóng modal)
    socket.on('unlock_resource', ({ type, resourceId, workspaceId }) => {
      if (!type || !resourceId || !workspaceId) return;

      const lockKey = `${workspaceId}_${type}_${resourceId}`;
      const lockInfo = activeLocks.get(lockKey);

      // Chỉ cho phép unlock nếu chính socket này đang giữ lock đó
      if (lockInfo && lockInfo.socketId === socket.id) {
        activeLocks.delete(lockKey);
        socketLockKeys.get(socket.id)?.delete(lockKey);

        // Xóa bộ đếm timeout để tránh rò rỉ bộ nhớ
        const timeout = lockTimeouts.get(lockKey);
        if (timeout) {
          clearTimeout(timeout);
          lockTimeouts.delete(lockKey);
        }

        console.log(`[SOCKET] Resource unlocked: ${lockKey} by ${socket.id}`);

        io.to(`workspace_${workspaceId}`).emit('RESOURCE_LOCK_CHANGED', {
          action: 'UNLOCKED',
          lockInfo,
        });
      }
    });

    // Khi client ngắt kết nối: tự động release tất cả locks của socket đó
    socket.on('disconnect', (reason) => {
      console.log(`[SOCKET] Client disconnected: ${socket.id}, reason: ${reason}`);

      const lockKeys = socketLockKeys.get(socket.id);
      if (lockKeys && lockKeys.size > 0) {
        for (const lockKey of lockKeys) {
          const lockInfo = activeLocks.get(lockKey);
          if (lockInfo) {
            activeLocks.delete(lockKey);
            
            // Xóa bộ đếm timeout
            const timeout = lockTimeouts.get(lockKey);
            if (timeout) {
              clearTimeout(timeout);
              lockTimeouts.delete(lockKey);
            }

            console.log(`[SOCKET] Auto-released lock on disconnect: ${lockKey}`);

            // Thông báo tới workspace room về việc lock được giải phóng
            io.to(`workspace_${lockInfo.workspaceId}`).emit('RESOURCE_LOCK_CHANGED', {
              action: 'UNLOCKED',
              lockInfo,
            });
          }
        }
        socketLockKeys.delete(socket.id);
      }
    });
  });

  return io;
};

// Lấy instance io hiện tại
const getIO = () => {
  return io;
};

// Gửi thông báo sự kiện cập nhật tới toàn bộ các máy trong cùng Workspace
const emitWorkspaceEvent = (workspaceId, eventName, payload = {}) => {
  if (io && workspaceId) {
    io.to(`workspace_${workspaceId}`).emit(eventName, payload);
  }
};

module.exports = {
  initSocket,
  getIO,
  emitWorkspaceEvent,
};
