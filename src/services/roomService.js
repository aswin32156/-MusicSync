const crypto = require('crypto');
const userService = require('./userService');

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

class RoomService {
    constructor() {
        this.rooms = new Map();
        this.socketToRoom = new Map();
        this.socketToUserId = new Map();
        this.MAX_MEMBERS = 6;
    }

    generateRoomCode() {
        let code = '';
        do {
            code = '';
            for (let i = 0; i < 6; i++) {
                code += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
            }
        } while (this.rooms.has(code));
        return code;
    }

    createRoom(username, roomName, password = null) {
        const roomCode = this.generateRoomCode();
        const persistentUser = userService.getOrCreateUser(username);

        const host = {
            id: persistentUser.id,
            username: persistentUser.username,
            avatarColor: persistentUser.avatarColor,
            host: true,
            sessionId: null
        };

        const room = {
            roomCode,
            roomName: roomName || `${username}'s Room`,
            password: password ? String(password).trim() : null,
            host,
            users: [host],
            queue: [],
            chatHistory: [],
            playbackState: {
                currentSongIndex: 0,
                currentTime: 0,
                playing: false,
                lastUpdated: Date.now()
            },
            createdAt: Date.now()
        };

        this.rooms.set(roomCode, room);
        userService.setUserOnlineStatus(persistentUser.id, true, roomCode);
        return room;
    }

    joinRoom(roomCode, username, password = null) {
        const code = (roomCode || '').trim().toUpperCase();
        const room = this.rooms.get(code);
        if (!room) return null;

        if (room.password) {
            if (!password || password.trim() !== room.password) {
                throw new Error('Incorrect password');
            }
        }

        const persistentUser = userService.getOrCreateUser(username);
        const alreadyInRoom = room.users.some(u => u.id === persistentUser.id);

        if (!alreadyInRoom && room.users.length >= this.MAX_MEMBERS) {
            throw new Error('Room is full. Maximum 6 members allowed.');
        }

        if (!alreadyInRoom) {
            const user = {
                id: persistentUser.id,
                username: persistentUser.username,
                avatarColor: persistentUser.avatarColor,
                host: false,
                sessionId: null
            };
            room.users.push(user);
        }

        userService.setUserOnlineStatus(persistentUser.id, true, code);
        return room;
    }

    getRoom(roomCode) {
        if (!roomCode) return null;
        return this.rooms.get(roomCode.trim().toUpperCase()) || null;
    }

    roomExists(roomCode) {
        if (!roomCode) return false;
        return this.rooms.has(roomCode.trim().toUpperCase());
    }

    getActiveRoomCount() {
        return this.rooms.size;
    }

    updateUserSocket(roomCode, username, socketId) {
        const room = this.getRoom(roomCode);
        if (!room) return;
        const user = room.users.find(u => u.username === username);
        if (user) {
            user.sessionId = socketId;
            this.socketToRoom.set(socketId, room.roomCode);
            this.socketToUserId.set(socketId, user.id);
        }
    }

    handleDisconnect(socketId) {
        const roomCode = this.socketToRoom.get(socketId);
        const userId = this.socketToUserId.get(socketId);
        this.socketToRoom.delete(socketId);
        this.socketToUserId.delete(socketId);

        if (!roomCode) return null;
        const room = this.rooms.get(roomCode);
        if (!room) return null;

        const userIndex = room.users.findIndex(u => u.sessionId === socketId || u.id === userId);
        if (userIndex !== -1) {
            const removedUser = room.users[userIndex];
            room.users.splice(userIndex, 1);

            if (userId) {
                userService.setUserOnlineStatus(userId, false, null);
            }

            // If empty, clean up room
            if (room.users.length === 0) {
                this.rooms.delete(roomCode);
                return { room: null, removedUser, roomCode, closed: true };
            }

            // If host left, assign new host to first user
            if (removedUser.host && room.users.length > 0) {
                room.users[0].host = true;
                room.host = room.users[0];
            }

            return { room, removedUser, roomCode, closed: false };
        }

        return null;
    }

    getRoomState(roomCode) {
        const room = this.getRoom(roomCode);
        if (!room) return null;

        const currentSong = this.getCurrentSong(room);
        return {
            roomCode: room.roomCode,
            roomName: room.roomName,
            host: room.host,
            users: [...room.users],
            queue: [...room.queue],
            currentSong,
            playbackState: { ...room.playbackState },
            chatHistory: [...room.chatHistory]
        };
    }

    getCurrentSong(room) {
        if (!room) return null;
        const idx = room.playbackState.currentSongIndex;
        if (idx >= 0 && idx < room.queue.length) {
            return room.queue[idx];
        }
        return null;
    }

    addChatMessage(room, chatMessage) {
        if (!room || !chatMessage) return;
        room.chatHistory.push(chatMessage);
        if (room.chatHistory.length > 200) {
            room.chatHistory.shift();
        }
    }
}

module.exports = new RoomService();
