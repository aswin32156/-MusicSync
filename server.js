require('dotenv').config();
const http = require('http');
const https = require('https');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const roomService = require('./src/services/roomService');
const musicService = require('./src/services/musicService');
const jioSaavnService = require('./src/services/jioSaavnService');
const userService = require('./src/services/userService');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
    }
});

const PORT = process.env.PORT || 8080;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// REST API ROUTES
// ==========================================

// Create Room
app.post('/api/rooms/create', (req, res) => {
    const { username, roomName, password } = req.body;
    if (!username || !username.trim()) {
        return res.status(400).json({ error: 'Username is required' });
    }
    const room = roomService.createRoom(username.trim(), roomName, password);
    const state = roomService.getRoomState(room.roomCode);
    return res.json(state);
});

// Join Room
app.post('/api/rooms/join', (req, res) => {
    const { roomCode, username, password } = req.body;
    if (!username || !username.trim()) {
        return res.status(400).json({ error: 'Username is required' });
    }
    if (!roomCode || !roomCode.trim()) {
        return res.status(400).json({ error: 'Room code is required' });
    }

    const code = roomCode.trim().toUpperCase();
    if (!roomService.roomExists(code)) {
        return res.status(404).json({ error: 'Room not found. Check the code and try again.' });
    }

    try {
        const room = roomService.joinRoom(code, username.trim(), password);
        const state = roomService.getRoomState(room.roomCode);
        return res.json(state);
    } catch (err) {
        if (err.message === 'Incorrect password') {
            return res.status(401).json({ error: err.message });
        }
        if (err.message.startsWith('Room is full')) {
            return res.status(409).json({ error: err.message });
        }
        return res.status(400).json({ error: err.message });
    }
});

// Get Room State
app.get('/api/rooms/:roomCode', (req, res) => {
    const state = roomService.getRoomState(req.params.roomCode);
    if (!state) {
        return res.status(404).json({ error: 'Room not found' });
    }
    return res.json(state);
});

// Check Room Exists
app.get('/api/rooms/:roomCode/exists', (req, res) => {
    const exists = roomService.roomExists(req.params.roomCode);
    return res.json({ exists });
});

// Local Music Library
app.get('/api/music/library', (req, res) => {
    return res.json(musicService.getLibrary());
});

// Local Search
app.get('/api/music/search', (req, res) => {
    const q = req.query.q || '';
    return res.json(musicService.searchLocalLibrary(q));
});

// Song By ID
app.get('/api/music/song/:songId', async (req, res) => {
    const song = await musicService.getSongById(req.params.songId);
    if (!song) {
        return res.status(404).json({ error: 'Song not found or unavailable' });
    }
    return res.json(song);
});

// External Search (JioSaavn + YouTube)
const handleExternalSearch = async (req, res) => {
    const query = req.query.q || req.query.query || '';
    const limit = parseInt(req.query.limit, 10) || 200;
    if (!query.trim()) {
        return res.json([]);
    }
    try {
        const results = await musicService.searchExternal(query, limit);
        return res.json(results);
    } catch (err) {
        console.error('External search error:', err.message);
        return res.status(500).json({ error: 'Search failed' });
    }
};
app.get('/api/music/search/external', handleExternalSearch);
app.get('/api/music/searchExternal', handleExternalSearch);

// Available Sources
app.get('/api/music/sources', (req, res) => {
    return res.json(musicService.getAvailableSources());
});

// Stats
app.get('/api/stats', (req, res) => {
    return res.json({ activeRooms: roomService.getActiveRoomCount() });
});

// Audio Streaming Proxy Helper
function proxyAudioStream(remoteUrl, req, res) {
    if (!remoteUrl || !remoteUrl.startsWith('http')) {
        return res.status(404).end();
    }

    try {
        const parsed = new URL(remoteUrl);
        const client = parsed.protocol === 'https:' ? https : http;

        const requestHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': 'https://www.jiosaavn.com/'
        };

        if (process.env.JIOSAAVN_COOKIE) {
            requestHeaders['Cookie'] = process.env.JIOSAAVN_COOKIE.trim();
        }

        if (req.headers.range) {
            requestHeaders['Range'] = req.headers.range;
        }

        const clientReq = client.get(remoteUrl, { headers: requestHeaders }, (remoteRes) => {
            // Forward status code (200, 206, etc.)
            res.status(remoteRes.statusCode || 200);

            // Forward relevant audio headers
            const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
            forwardHeaders.forEach(header => {
                if (remoteRes.headers[header]) {
                    res.setHeader(header, remoteRes.headers[header]);
                }
            });

            remoteRes.pipe(res);
        });

        clientReq.on('error', (err) => {
            console.error('Streaming error for URL:', remoteUrl, err.message);
            if (!res.headersSent) {
                res.status(502).end();
            }
        });

        req.on('close', () => {
            clientReq.destroy();
        });
    } catch (err) {
        console.error('Invalid streaming URL:', remoteUrl, err.message);
        if (!res.headersSent) res.status(500).end();
    }
}

// Media Stream by URL
app.get('/api/music/stream', (req, res) => {
    const audioUrl = req.query.url;
    if (!audioUrl) return res.status(400).end();
    proxyAudioStream(audioUrl, req, res);
});

// Media Stream by Song ID
app.get('/api/music/stream/:songId', async (req, res) => {
    const songId = req.params.songId;
    if (!songId) return res.status(400).end();

    try {
        let song = await musicService.getSongById(songId);
        let remoteUrl = song ? song.audioUrl : null;

        if (!remoteUrl || remoteUrl.startsWith('jio_') || remoteUrl.includes('preview') || remoteUrl.includes('jiotune')) {
            const cleanId = songId.startsWith('jio_') ? songId.substring(4) : songId;
            const resolved = await jioSaavnService.getSongById(cleanId);
            if (resolved && resolved.audioUrl && !resolved.audioUrl.startsWith('jio_')) {
                remoteUrl = resolved.audioUrl;
                if (song) {
                    song.audioUrl = remoteUrl;
                    musicService.cacheSong(song);
                }
            }
        }

        if (!remoteUrl || !remoteUrl.startsWith('http')) {
            return res.status(404).end();
        }

        proxyAudioStream(remoteUrl, req, res);
    } catch (err) {
        console.error('Error streaming song ID:', songId, err.message);
        if (!res.headersSent) res.status(500).end();
    }
});

// SPA fallback for all unmatched GET requests
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// REAL-TIME SOCKET.IO HANDLERS
// ==========================================

io.on('connection', (socket) => {
    // 1. User Register / Join Room
    socket.on('room:register', (data) => {
        const { roomCode, username } = data || {};
        if (!roomCode || !username) return;

        const code = roomCode.trim().toUpperCase();
        socket.join(code);
        roomService.updateUserSocket(code, username, socket.id);

        const room = roomService.getRoom(code);
        if (!room) return;

        const user = room.users.find(u => u.username === username);
        const avatarColor = user ? user.avatarColor : '#1DB954';

        const systemMsg = {
            id: require('crypto').randomUUID(),
            username: 'System',
            avatarColor,
            message: `${username} joined the room`,
            type: 'system',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        roomService.addChatMessage(room, systemMsg);

        // Broadcast updated state and chat
        const roomState = roomService.getRoomState(code);
        io.to(code).emit('room:state', roomState);
        io.to(code).emit('room:chat', systemMsg);
    });

    // 2. Personal Sync
    socket.on('room:sync', (data) => {
        const { roomCode } = data || {};
        if (!roomCode) return;
        const state = roomService.getRoomState(roomCode);
        if (state) {
            socket.emit('room:sync', state);
        }
    });

    // 3. Playback Commands
    socket.on('room:playback', (command) => {
        const { roomCode, action, currentTime } = command || {};
        if (!roomCode) return;

        const room = roomService.getRoom(roomCode);
        if (!room) return;

        const state = room.playbackState;
        const now = Date.now();

        switch (action) {
            case 'play':
                state.playing = true;
                if (typeof currentTime === 'number') state.currentTime = currentTime;
                break;
            case 'pause':
                state.playing = false;
                if (typeof currentTime === 'number') state.currentTime = currentTime;
                break;
            case 'seek':
                if (typeof currentTime === 'number') state.currentTime = currentTime;
                break;
            case 'next': {
                const nextIndex = state.currentSongIndex + 1;
                if (nextIndex < room.queue.length) {
                    state.currentSongIndex = nextIndex;
                    state.currentTime = 0;
                    state.playing = true;
                } else {
                    state.playing = false;
                    state.currentTime = 0;
                }
                break;
            }
            case 'previous': {
                const prevIndex = state.currentSongIndex - 1;
                if (prevIndex >= 0) {
                    state.currentSongIndex = prevIndex;
                    state.currentTime = 0;
                    state.playing = true;
                }
                break;
            }
            case 'select': {
                const selectIndex = parseInt(currentTime, 10);
                if (selectIndex >= 0 && selectIndex < room.queue.length) {
                    state.currentSongIndex = selectIndex;
                    state.currentTime = 0;
                    state.playing = true;
                }
                break;
            }
            case 'timesync':
                if (typeof currentTime === 'number') state.currentTime = currentTime;
                break;
        }

        state.lastUpdated = now;

        const currentSong = roomService.getCurrentSong(room);
        const payload = {
            ...state,
            playbackState: { ...state },
            currentSong: currentSong,
            estimatedCurrentTime: state.currentTime
        };

        io.to(room.roomCode).emit('room:playback', payload);

        if (['next', 'previous', 'select'].includes(action)) {
            io.to(room.roomCode).emit('room:state', roomService.getRoomState(room.roomCode));
        }
    });

    // 4. Add to Queue
    socket.on('room:queue:add', async (request) => {
        try {
            const { roomCode, username, songId, title, artist, album, coverUrl, durationSeconds, audioUrl, playImmediately } = request || {};
            if (!roomCode || !songId) return;

            const room = roomService.getRoom(roomCode);
            if (!room) return;

            let song = await musicService.getSongById(songId);
            if (song) {
                if (title && (song.title === 'YouTube Track' || song.title === 'YouTube Video' || !song.title)) {
                    song.title = title;
                }
                if (artist && (song.artist === 'YouTube' || !song.artist)) {
                    song.artist = artist;
                }
                if (album && (!song.album || song.album === 'YouTube Music' || song.album === 'YouTube Video')) {
                    song.album = album;
                }
                if (coverUrl && !song.coverUrl) {
                    song.coverUrl = coverUrl;
                }
                if (durationSeconds && (!song.durationSeconds || song.durationSeconds <= 0)) {
                    song.durationSeconds = durationSeconds;
                }
                if ((!song.audioUrl || song.audioUrl.startsWith('jio_')) && audioUrl && audioUrl.startsWith('http')) {
                    song.audioUrl = audioUrl;
                }
            } else {
                song = {
                    id: songId,
                    title: title || 'Unknown Title',
                    artist: artist || 'Unknown Artist',
                    album: album || '',
                    coverUrl: coverUrl || '',
                    durationSeconds: durationSeconds || 0,
                    audioUrl: audioUrl || songId,
                    addedBy: username
                };
                musicService.cacheSong(song);
            }

            // If JioSaavn, make sure full-length audio is resolved
            if (song.id.startsWith('jio_') && (!song.audioUrl || song.audioUrl.startsWith('jio_') || song.audioUrl.includes('preview') || song.audioUrl.includes('jiotune'))) {
                const cleanId = song.id.substring(4);
                const resolved = await jioSaavnService.getSongById(cleanId);
                if (resolved && resolved.audioUrl && !resolved.audioUrl.startsWith('jio_')) {
                    song.audioUrl = resolved.audioUrl;
                    if (resolved.durationSeconds && !song.durationSeconds) {
                        song.durationSeconds = resolved.durationSeconds;
                    }
                    musicService.cacheSong(song);
                }
            }

            const queuedSong = { ...song, addedBy: username };
            room.queue.push(queuedSong);

            // Auto-play if first song or playImmediately
            if (room.queue.length === 1 || playImmediately) {
                room.playbackState.currentSongIndex = room.queue.length - 1;
                room.playbackState.currentTime = 0;
                room.playbackState.playing = true;
                room.playbackState.lastUpdated = Date.now();
            }

            const systemMsg = {
                id: require('crypto').randomUUID(),
                username: 'System',
                avatarColor: '#1DB954',
                message: `${username || 'Someone'} ${playImmediately ? 'started playing' : 'added to the queue'} "${song.title}"`,
                type: 'system',
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
            roomService.addChatMessage(room, systemMsg);

            const roomState = roomService.getRoomState(room.roomCode);
            const activeCurrentSong = roomService.getCurrentSong(room);
            io.to(room.roomCode).emit('room:state', roomState);
            io.to(room.roomCode).emit('room:playback', {
                ...room.playbackState,
                playbackState: { ...room.playbackState },
                currentSong: activeCurrentSong,
                estimatedCurrentTime: room.playbackState.currentTime
            });
            io.to(room.roomCode).emit('room:chat', systemMsg);
        } catch (err) {
            console.error('Error handling room:queue:add:', err);
        }
    });

    // 4b. Add Batch to Queue (Playlist Import / Custom Playlist)
    socket.on('room:queue:addBatch', async (request) => {
        try {
            const { roomCode, username, songs, playImmediately, playlistTitle } = request || {};
            if (!roomCode || !Array.isArray(songs) || songs.length === 0) return;

            const room = roomService.getRoom(roomCode);
            if (!room) return;

            const startIndex = room.queue.length;

            for (const s of songs) {
                if (!s || !s.id) continue;
                musicService.cacheSong(s);
                room.queue.push({
                    ...s,
                    addedBy: username || 'Anonymous'
                });
            }

            // Auto-play if empty queue or playImmediately
            if (startIndex === 0 || playImmediately) {
                room.playbackState.currentSongIndex = startIndex;
                room.playbackState.currentTime = 0;
                room.playbackState.playing = true;
                room.playbackState.lastUpdated = Date.now();
            }

            const systemMsg = {
                id: require('crypto').randomUUID(),
                username: 'System',
                avatarColor: '#1DB954',
                message: `${username || 'Someone'} ${playImmediately ? 'started playing playlist' : 'added'} "${playlistTitle || 'Playlist'}" (${songs.length} songs) to the queue`,
                type: 'system',
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
            roomService.addChatMessage(room, systemMsg);

            const roomState = roomService.getRoomState(room.roomCode);
            const activeCurrentSong = roomService.getCurrentSong(room);
            io.to(room.roomCode).emit('room:state', roomState);
            io.to(room.roomCode).emit('room:playback', {
                ...room.playbackState,
                playbackState: { ...room.playbackState },
                currentSong: activeCurrentSong,
                estimatedCurrentTime: room.playbackState.currentTime
            });
            io.to(room.roomCode).emit('room:chat', systemMsg);
        } catch (err) {
            console.error('Error handling room:queue:addBatch:', err);
        }
    });

    // 5. Remove from Queue
    socket.on('room:queue:remove', (request) => {
        const { roomCode, songId } = request || {};
        if (!roomCode || !songId) return;

        const room = roomService.getRoom(roomCode);
        if (!room) return;

        const removedIndex = room.queue.findIndex(s => s.id === songId);
        if (removedIndex === -1) return;

        room.queue.splice(removedIndex, 1);

        const state = room.playbackState;
        if (room.queue.length === 0) {
            state.currentSongIndex = 0;
            state.currentTime = 0;
            state.playing = false;
        } else if (removedIndex < state.currentSongIndex) {
            state.currentSongIndex--;
        } else if (removedIndex === state.currentSongIndex) {
            if (state.currentSongIndex >= room.queue.length) {
                state.currentSongIndex = 0;
                state.currentTime = 0;
                state.playing = false;
            } else {
                state.currentTime = 0;
            }
        }
        state.lastUpdated = Date.now();

        const roomState = roomService.getRoomState(room.roomCode);
        const currentSong = roomService.getCurrentSong(room);
        io.to(room.roomCode).emit('room:state', roomState);
        io.to(room.roomCode).emit('room:playback', {
            ...state,
            playbackState: { ...state },
            currentSong: currentSong,
            estimatedCurrentTime: state.currentTime
        });
    });

    // 6. Reorder Queue
    socket.on('room:queue:reorder', (request) => {
        const { roomCode, fromIndex, toIndex } = request || {};
        if (!roomCode) return;

        const room = roomService.getRoom(roomCode);
        if (!room) return;

        if (fromIndex < 0 || fromIndex >= room.queue.length || toIndex < 0 || toIndex >= room.queue.length) return;

        const currentSong = roomService.getCurrentSong(room);
        const [moved] = room.queue.splice(fromIndex, 1);
        room.queue.splice(toIndex, 0, moved);

        if (currentSong) {
            const newIndex = room.queue.findIndex(s => s.id === currentSong.id);
            if (newIndex >= 0) {
                room.playbackState.currentSongIndex = newIndex;
            }
        }
        room.playbackState.lastUpdated = Date.now();

        const roomState = roomService.getRoomState(room.roomCode);
        io.to(room.roomCode).emit('room:state', roomState);
        io.to(room.roomCode).emit('room:playback', {
            ...room.playbackState,
            playbackState: { ...room.playbackState },
            currentSong: currentSong,
            estimatedCurrentTime: room.playbackState.currentTime
        });
    });

    // 7. Chat Message
    socket.on('room:chat', (data) => {
        const { roomCode, username, message } = data || {};
        if (!roomCode || !message || !message.trim()) return;

        const room = roomService.getRoom(roomCode);
        if (!room) return;

        const user = room.users.find(u => u.username === username);
        const chatMsg = {
            id: require('crypto').randomUUID(),
            username: username || 'Anonymous',
            avatarColor: user ? user.avatarColor : '#1DB954',
            message: message.trim(),
            type: 'user',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        roomService.addChatMessage(room, chatMsg);
        io.to(room.roomCode).emit('room:chat', chatMsg);
    });

    // 8. Disconnect Handler
    socket.on('disconnect', () => {
        const result = roomService.handleDisconnect(socket.id);
        if (result && !result.closed && result.room) {
            const systemMsg = {
                id: require('crypto').randomUUID(),
                username: 'System',
                avatarColor: '#E91E63',
                message: `${result.removedUser.username} left the room`,
                type: 'system',
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
            roomService.addChatMessage(result.room, systemMsg);

            const roomState = roomService.getRoomState(result.roomCode);
            io.to(result.roomCode).emit('room:state', roomState);
            io.to(result.roomCode).emit('room:chat', systemMsg);
        }
    });
});

// Start Server
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🎵 MusicSync Node.js Server running at http://localhost:${PORT}`);
    });
}

module.exports = app;
