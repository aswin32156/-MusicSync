const crypto = require('crypto');

const AVATAR_COLORS = [
    "#1DB954", "#1ED760", "#E91E63", "#9C27B0", "#673AB7",
    "#3F51B5", "#2196F3", "#00BCD4", "#009688", "#FF9800",
    "#FF5722", "#795548", "#607D8B", "#F44336", "#4CAF50"
];

class UserService {
    constructor() {
        this.usersById = new Map();
        this.usersByUsername = new Map();
    }

    createUser(username) {
        if (!username || !username.trim()) throw new Error('Username is required');
        const cleanName = username.trim();
        const lower = cleanName.toLowerCase();
        if (this.usersByUsername.has(lower)) {
            return this.usersByUsername.get(lower);
        }

        const userId = crypto.randomUUID();
        const avatarColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
        const user = {
            id: userId,
            username: cleanName,
            avatarColor,
            online: false,
            currentRoomCode: null
        };

        this.usersById.set(userId, user);
        this.usersByUsername.set(lower, user);
        return user;
    }

    getUserById(userId) {
        return this.usersById.get(userId) || null;
    }

    getUserByUsername(username) {
        if (!username) return null;
        return this.usersByUsername.get(username.trim().toLowerCase()) || null;
    }

    getOrCreateUser(username) {
        const existing = this.getUserByUsername(username);
        if (existing) return existing;
        return this.createUser(username);
    }

    searchUsers(query) {
        if (!query || !query.trim()) return [];
        const lower = query.trim().toLowerCase();
        const results = [];
        for (const user of this.usersByUsername.values()) {
            if (user.username.toLowerCase().includes(lower)) {
                results.push(user);
                if (results.length >= 20) break;
            }
        }
        return results;
    }

    setUserOnlineStatus(userId, online, roomCode = null) {
        const user = this.usersById.get(userId);
        if (user) {
            user.online = Boolean(online);
            user.currentRoomCode = online ? roomCode : null;
        }
    }
}

module.exports = new UserService();
