// ===== MusicSync Application =====

// ===== SCREEN NAVIGATION WITH HISTORY =====
const screenHistory = [];

window.showScreen = function (screenId, pushHistory = true) {
    console.log('showScreen called with:', screenId);
    const current = document.querySelector('.screen.active');
    const currentId = current ? current.id : null;
    // Push current to history so we can go back
    // Skip if: not pushing, no current screen, same destination, going home already in history, or inside room
    if (pushHistory && currentId && currentId !== screenId && currentId !== 'room-screen') {
        // Avoid consecutive duplicates in the stack
        if (screenHistory[screenHistory.length - 1] !== currentId) {
            screenHistory.push(currentId);
        }
    }
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    setTimeout(() => {
        const screen = document.getElementById(screenId);
        if (screen) {
            screen.classList.add('active');
            console.log('Screen activated:', screenId);
        } else {
            console.error('Screen not found:', screenId);
        }
    }, 50);
    // Update browser history so the OS/browser back button works
    if (pushHistory) {
        history.pushState({ screenId }, '', '#' + screenId);
    }
    _updateBackBtnVisibility();
};

window.goBack = function () {
    if (screenHistory.length > 0) {
        const prev = screenHistory.pop();
        showScreen(prev, false);
        // Keep browser URL in sync without adding a new history entry
        history.replaceState({ screenId: prev }, '', '#' + prev);
    } else {
        showScreen('home-screen', false);
        history.replaceState({ screenId: 'home-screen' }, '', '#home-screen');
    }
};

function _updateBackBtnVisibility() {
    // show/hide the room-level back btn (not applicable in room-screen)
    // The main back buttons are per-screen (create/join already have them)
}

// Handle browser back button
window.addEventListener('popstate', (e) => {
    if (e.state && e.state.screenId) {
        showScreen(e.state.screenId, false);
    } else {
        goBack();
    }
});

// State
let socket = null;
let currentUser = null;
let currentUserId = null;
let currentRoom = null;
let isHost = false;
let isPlaying = false;
let currentSongIndex = -1;
let progressInterval = null;
let currentTime = 0;
let duration = 0;
let currentUsers = [];
let connectionRetries = 0;
let maxRetries = 5;
let isConnecting = false;
let pendingActions = [];
let roomStateRefreshTimeout = null;
let roomStatePollInterval = null;
let ytVideoSafetyCheckInterval = null;
let ytForcePlayInterval = null; // Continuous monitor to ensure playback never stops
let friendsRefreshInterval = null;
let lastForwardMoveAt = 0;
let lastForwardMoveIndex = -1;
let _lastUserMove = 0;
let nextSongSent = false; // Shared flag to prevent double 'next' from ended event and progress timer

function refreshFriendsDataSafely() {
    if (typeof loadFriends === 'function') {
        loadFriends();
    }
    if (typeof loadFriendRequests === 'function') {
        loadFriendRequests();
    }
}

function executePendingActions() {
    while (pendingActions.length > 0) {
        const action = pendingActions.shift();
        try { action(); } catch (e) { console.error('Pending action error:', e); }
    }
}

function waitForConnection(action) {
    if (socket && socket.connected) {
        action();
    } else {
        pendingActions.push(action);
        if (currentRoom && currentRoom.roomCode && !isConnecting) {
            connectWebSocket(currentRoom.roomCode);
        }
    }
}

function getListenerCount(users) {
    return (Array.isArray(users) ? users : []).filter(user => !user.host).length;
}

async function refreshRoomStateOnce(roomCode) {
    if (!roomCode) return;
    try {
        const res = await fetch('/api/rooms/' + encodeURIComponent(roomCode));
        if (!res.ok) return;
        const latest = await res.json();
        updateRoomUI(latest);
    } catch (e) {
        // Ignore transient polling errors; realtime updates keep the normal flow.
    }
}

function scheduleRoomStateRefresh(delayMs = 150) {
    if (!currentRoom || !currentRoom.roomCode) return;

    if (roomStateRefreshTimeout) {
        clearTimeout(roomStateRefreshTimeout);
    }

    roomStateRefreshTimeout = setTimeout(() => {
        roomStateRefreshTimeout = null;
        refreshRoomStateOnce(currentRoom.roomCode);
    }, delayMs);
}

function isYouTubeMedia(song) {
    return !!(song && song.id && (song.id.startsWith('ytv_') || song.id.startsWith('yt_')));
}

function extractYouTubeId(song) {
    if (!song || !song.id) return '';
    return song.id.replace(/^(ytv_|yt_)/, '');
}

function startRoomStatePolling(roomCode) {
    if (!roomCode) return;
    stopRoomStatePolling();
    roomStatePollInterval = setInterval(() => {
        const activeSong = currentRoom && Array.isArray(currentRoom.queue)
            ? currentRoom.queue[currentSongIndex]
            : null;
        const isActiveVideoPlayback = !!(
            activeSong && isYouTubeMedia(activeSong) && isPlaying
        );

        // Video playback is sensitive to forced periodic state resync.
        // Keep realtime websocket updates, but skip fallback polling while actively playing video.
        if (isActiveVideoPlayback) {
            return;
        }

        refreshRoomStateOnce(roomCode);
    }, 4000);

    // Start YouTube safety check to catch missed background pause events
    startYtVideoSafetyCheck();
}

function startYtVideoSafetyCheck() {
    if (ytVideoSafetyCheckInterval) clearInterval(ytVideoSafetyCheckInterval);
    if (ytForcePlayInterval) clearInterval(ytForcePlayInterval);

    // RELENTLESS monitor - runs CONSTANTLY to keep video playing
    // Like music that never stops
    ytForcePlayInterval = setInterval(() => {
        if (!currentRoom || !ytPlayer || !window.YT) return;

        const activeSong = currentRoom && Array.isArray(currentRoom.queue)
            ? currentRoom.queue[currentSongIndex]
            : null;

        const isVideoSong = isYouTubeMedia(activeSong);

        // If it's a video song AND user is NOT pausing → KEEP IT PLAYING
        if (isVideoSong && !ytUserPaused) {
            try {
                const state = ytPlayer.getPlayerState();
                // Don't restart ended videos — let the ENDED handler advance the queue
                if (state === YT.PlayerState.ENDED) {
                    return;
                }
                // ANY state that's not PLAYING or BUFFERING = RESUME
                if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) {
                    console.log('[YouTube RELENTLESS] State ' + state + ' - FORCING PLAY NOW');
                    suppressYtStateSync(2000);
                    ytPlayer.playVideo();
                }
            } catch (err) {
                // Continue anyway
            }
        }
    }, 100); // Check every 100ms - never let it stop
}

function stopYtVideoSafetyCheck() {
    if (ytVideoSafetyCheckInterval) {
        clearInterval(ytVideoSafetyCheckInterval);
        ytVideoSafetyCheckInterval = null;
    }
    if (ytForcePlayInterval) {
        clearInterval(ytForcePlayInterval);
        ytForcePlayInterval = null;
    }
}

function stopRoomStatePolling() {
    if (roomStatePollInterval) {
        clearInterval(roomStatePollInterval);
        roomStatePollInterval = null;
    }
    if (roomStateRefreshTimeout) {
        clearTimeout(roomStateRefreshTimeout);
        roomStateRefreshTimeout = null;
    }
    stopYtVideoSafetyCheck();
}


// Audio player
const audioPlayer = new Audio();
audioPlayer.volume = 1.0;
audioPlayer.crossOrigin = "anonymous"; // Enable CORS for external audio sources
let audioUnlocked = false;
let awaitingAudioResume = false;
let pendingAudioResumeHandler = null;
const AUDIO_UNLOCK_SRC = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
const audioUnlockProbe = new Audio(AUDIO_UNLOCK_SRC);
audioUnlockProbe.preload = 'auto';

// Unlock audio playback on user gesture (needed for browsers' autoplay policy)
function unlockAudio() {
    if (audioUnlocked) return Promise.resolve();

    audioUnlockProbe.muted = true;
    const unlockPromise = audioUnlockProbe.play();
    if (!unlockPromise || typeof unlockPromise.then !== 'function') {
        audioUnlocked = true;
        return Promise.resolve();
    }

    return unlockPromise.then(() => {
        audioUnlockProbe.pause();
        audioUnlockProbe.currentTime = 0;
        audioUnlocked = true;
        console.log('[Audio] Audio unlocked for autoplay');
    }).catch((err) => {
        console.warn('[Audio] Could not unlock audio', err);
        throw err;
    });
}

function requestUserAudioResume() {
    if (awaitingAudioResume) return;
    awaitingAudioResume = true;
    showToast('Tap anywhere once to enable room audio.', 'info');

    const resumeAudio = () => {
        awaitingAudioResume = false;
        pendingAudioResumeHandler = null;
        document.removeEventListener('pointerdown', resumeAudio);
        document.removeEventListener('keydown', resumeAudio);

        unlockAudio()
            .catch(() => { })
            .finally(() => {
                const activeSong = currentRoom && Array.isArray(currentRoom.queue)
                    ? currentRoom.queue[currentSongIndex]
                    : null;
                const hasAudioSource = !!(audioPlayer.getAttribute('data-song-id') || audioPlayer.getAttribute('src') || audioPlayer.currentSrc);

                if (isPlaying && hasAudioSource && !(activeSong && isYouTubeMedia(activeSong))) {
                    audioPlayer.play().catch(() => { });
                }
            });
    };

    pendingAudioResumeHandler = resumeAudio;
    document.addEventListener('pointerdown', resumeAudio);
    document.addEventListener('keydown', resumeAudio);
}

function cancelPendingAudioResume() {
    if (!pendingAudioResumeHandler) {
        awaitingAudioResume = false;
        return;
    }

    document.removeEventListener('pointerdown', pendingAudioResumeHandler);
    document.removeEventListener('keydown', pendingAudioResumeHandler);
    pendingAudioResumeHandler = null;
    awaitingAudioResume = false;
}

// A first interaction anywhere on the page usually satisfies autoplay policies.
document.addEventListener('pointerdown', () => {
    unlockAudio().catch(() => { });
}, { once: true });

function stopAudioPlayback(clearSource = false) {
    cancelPendingAudioResume();
    audioPlayer.pause();

    if (!clearSource) {
        return;
    }

    const hasSource = !!(audioPlayer.getAttribute('data-song-id') || audioPlayer.getAttribute('src') || audioPlayer.currentSrc);

    try {
        audioPlayer.currentTime = 0;
    } catch (err) { }

    audioPlayer.removeAttribute('data-song-id');
    audioPlayer.srcObject = null;
    audioPlayer.src = '';
    audioPlayer.removeAttribute('src');

    if (hasSource) {
        audioPlayer.load();
    }
}

audioPlayer.addEventListener('ended', () => {
    // Don't send next if user just clicked next/previous to avoid double-advance
    if (Date.now() - _lastUserMove < 5000) return;
    // Don't send next if already sent from progress timer
    if (nextSongSent) return;
    nextSongSent = true;
    sendPlaybackCommand('next', 0);
});

let lastTimeSync = 0;
audioPlayer.addEventListener('timeupdate', () => {
    currentTime = audioPlayer.currentTime;
    duration = audioPlayer.duration || 0;
    updateProgress();
    const now = Date.now();
    if (now - lastTimeSync >= 5000) {
        lastTimeSync = now;
        sendPlaybackCommand('timesync', audioPlayer.currentTime);
    }
});



audioPlayer.addEventListener('loadedmetadata', () => {
    duration = audioPlayer.duration || 0;
    document.getElementById('time-total').textContent = formatTime(Math.floor(duration));
});

// Add error handling for audio playback
audioPlayer.addEventListener('error', (e) => {
    console.error('Audio playback error:', e);

    // Fallback from proxy stream to direct audio URL if proxy streaming fails
    const currentSong = currentRoom && currentRoom.currentSong;
    const currentSongId = audioPlayer.getAttribute('data-song-id');
    const hasTriedFallback = audioPlayer.getAttribute('data-tried-direct-fallback') === 'true';
    if (currentSong && currentSong.id === currentSongId && !hasTriedFallback && currentSong.audioUrl && currentSong.audioUrl.startsWith('http') && (audioPlayer.src.includes('/api/music/stream/') || audioPlayer.src.includes('%2Fapi%2Fmusic%2Fstream%2F'))) {
        console.warn('Proxy stream encountered error, falling back to direct audio URL:', currentSong.audioUrl);
        audioPlayer.setAttribute('data-tried-direct-fallback', 'true');
        audioPlayer.src = currentSong.audioUrl;
        audioPlayer.load();
        if (isPlaying) {
            if (currentTime > 0) audioPlayer.currentTime = currentTime;
            audioPlayer.play().catch(err => console.warn('Direct audio fallback play error:', err));
        }
        return;
    }

    const error = audioPlayer.error;
    let errorMsg = 'Failed to play audio';

    if (error) {
        switch (error.code) {
            case error.MEDIA_ERR_ABORTED:
                errorMsg = 'Audio playback was aborted';
                break;
            case error.MEDIA_ERR_NETWORK:
                errorMsg = 'Network error while loading audio';
                break;
            case error.MEDIA_ERR_DECODE:
                errorMsg = 'Audio format not supported';
                break;
            case error.MEDIA_ERR_SRC_NOT_SUPPORTED:
                errorMsg = 'Audio source not available';
                break;
        }
    }

    console.error('Audio error details:', errorMsg);
    showToast(errorMsg + '. Try skipping to next song.', 'error');

    // Auto-skip to next song
    setTimeout(() => sendPlaybackCommand('next', 0), 2000);
});

audioPlayer.addEventListener('loadstart', () => {
    console.log('Loading audio:', audioPlayer.src);
});

audioPlayer.addEventListener('canplay', () => {
    console.log('Audio ready to play');
});

// Splash Screen - DISABLED, go directly to home
// ===== API Calls =====
async function fetchStats() {
    try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        document.getElementById('active-rooms-count').textContent = data.activeRooms || 0;
    } catch (e) {
        console.error('Failed to fetch stats:', e);
    }
}

async function createRoom() {
    console.log('createRoom function called');
    const username = document.getElementById('create-username').value.trim();
    const roomName = document.getElementById('create-room-name').value.trim();
    const password = document.getElementById('create-password').value.trim();
    const errorEl = document.getElementById('create-error');
    errorEl.classList.add('hidden');

    if (!username) {
        showFormError('create-error', 'Please enter your name');
        return;
    }

    unlockAudio();

    const btn = document.getElementById('btn-create-room');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';

    try {
        const res = await fetch('/api/rooms/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                roomName: roomName || undefined,
                password: password || undefined
            })
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to create room');
        }

        const roomState = await res.json();
        currentUser = username;
        currentRoom = roomState;
        isHost = true;

        enterRoom(roomState);
        showToast('Room created! Share the code with friends.', 'success');
    } catch (e) {
        showFormError('create-error', e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-rocket"></i> Create Room';
    }
}

async function joinRoom() {
    const username = document.getElementById('join-username').value.trim();
    const roomCode = document.getElementById('join-room-code').value.trim().toUpperCase();
    const password = document.getElementById('join-password').value.trim();
    const errorEl = document.getElementById('join-error');
    errorEl.classList.add('hidden');

    if (!username) {
        showFormError('join-error', 'Please enter your name');
        return;
    }
    if (!roomCode || roomCode.length < 4) {
        showFormError('join-error', 'Please enter a valid room code');
        return;
    }

    unlockAudio();

    const btn = document.getElementById('btn-join-room');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Joining...';

    try {
        const res = await fetch('/api/rooms/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                roomCode,
                password: password || undefined
            })
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to join room');
        }

        const roomState = await res.json();
        currentUser = username;
        currentRoom = roomState;
        isHost = false;

        enterRoom(roomState);
        showToast('Joined the room!', 'success');
    } catch (e) {
        showFormError('join-error', e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-headphones"></i> Join Room';
    }
}

// ===== Room Logic =====
function enterRoom(roomState) {
    console.log('[Room] Entering room:', roomState);
    showScreen('room-screen');
    updateRoomUI(roomState);

    console.log('[Room] About to connect WebSocket with room code:', roomState.roomCode);
    connectWebSocket(roomState.roomCode);

    console.log('[Room] Checking sources...');
    checkSources();

    startRoomStatePolling(roomState.roomCode);
    scheduleRoomStateRefresh(0);

    // Show/hide host controls
    const hostIndicator = document.getElementById('host-indicator');
    if (isHost) {
        hostIndicator.classList.add('hidden');
    } else {
        hostIndicator.classList.remove('hidden');
    }
    console.log('[Room] Room entry complete. isHost:', isHost);
}

function updateRoomUI(state) {
    if (!state || typeof state !== 'object') return;

    currentRoom = state;
    const roomUsers = Array.isArray(state.users) ? state.users : [];
    const roomQueue = Array.isArray(state.queue) ? state.queue : [];

    // Room info
    document.getElementById('room-name-display').textContent = state.roomName || 'Music Room';
    document.getElementById('room-code-display').textContent = state.roomCode;

    // Set current user ID (extract from users list)
    if (!currentUserId && currentUser) {
        const user = roomUsers.find(u => u.username === currentUser);
        if (user) {
            currentUserId = user.id;

            // Friends panel is optional; avoid crashing room init if those handlers are absent.
            refreshFriendsDataSafely();

            if (friendsRefreshInterval) {
                clearInterval(friendsRefreshInterval);
            }
            friendsRefreshInterval = setInterval(() => {
                refreshFriendsDataSafely();
            }, 10000);
        }
    }

    // Users
    updateUsersList(roomUsers);

    const _newIdx = state?.playbackState?.currentSongIndex;
    const _timeSinceMove = Date.now() - _lastUserMove;

    // Transition lock / rapid skip protection
    let _skipPlayback = false;
    if (localTransitionTargetIndex !== null && (Date.now() - localTransitionTimestamp) < LOCAL_TRANSITION_LOCK_MS) {
        if (typeof _newIdx === 'number' && _newIdx !== localTransitionTargetIndex) {
            _skipPlayback = true;
        } else {
            localTransitionTargetIndex = null;
        }
    } else if (_timeSinceMove < 1000 && typeof _newIdx === 'number' && _newIdx !== currentSongIndex) {
        _skipPlayback = true;
    }

    // Queue
    const queuePlaybackState = _skipPlayback
        ? { currentSongIndex: currentSongIndex }
        : state.playbackState;
    updateQueue(roomQueue, queuePlaybackState);

    if (!_skipPlayback) {
        const playbackIndex = Number(state?.playbackState?.currentSongIndex);
        const fallbackSong = Number.isInteger(playbackIndex)
            && playbackIndex >= 0
            && playbackIndex < roomQueue.length
            ? roomQueue[playbackIndex]
            : null;
        const stateSong = (state.currentSong && state.currentSong.title)
            ? state.currentSong
            : fallbackSong;

        if (stateSong) {
            updateNowPlaying(stateSong, state.playbackState);
        } else if (roomQueue.length === 0) {
            updateNowPlaying(null, state.playbackState);
        }
    }

    // Check host status using the current user record in this room state.
    const me = roomUsers.find(user =>
        (currentUserId && user.id === currentUserId)
        || (!currentUserId && user.username === currentUser)
    );
    if (me) {
        currentUserId = me.id;
        isHost = !!me.host;
    } else {
        isHost = !!(state.host && state.host.username === currentUser);
    }

    const hostIndicator = document.getElementById('host-indicator');
    if (hostIndicator) {
        hostIndicator.classList.toggle('hidden', isHost);
    }
}

function updateUsersList(users) {
    currentUsers = Array.isArray(users) ? [...users] : [];

    const list = document.getElementById('users-list');
    const countBadge = document.getElementById('user-count');
    if (countBadge) {
        countBadge.textContent = getListenerCount(currentUsers);
    }

    if (currentRoom) {
        currentRoom.users = currentUsers;
    }

    if (list) {
        list.innerHTML = currentUsers.map(user => `
        <div class="user-item">
            <div class="user-avatar" style="background: ${escapeAttr(user.avatarColor)}">
                ${escapeHtml(user.username.charAt(0).toUpperCase())}
                <div class="online-dot"></div>
            </div>
            <div class="user-info">
                <div class="user-name">${escapeHtml(user.username)}${user.username === currentUser ? ' (You)' : ''}</div>
                <div class="user-role">${user.host ? '👑 Host' : 'Listener'}</div>
            </div>
            ${user.host ? '<i class="fas fa-crown host-badge"></i>' : ''}
        </div>
    `).join('');
    }

    const modal = document.getElementById('listeners-modal');
    if (modal && !modal.classList.contains('hidden')) {
        renderListenersModal();
    }
}

function getActiveListeners() {
    if (currentRoom && Array.isArray(currentRoom.users) && currentRoom.users.length > 0) {
        return currentRoom.users;
    }
    if (Array.isArray(currentUsers) && currentUsers.length > 0) {
        return currentUsers;
    }
    return [];
}

function renderListenersModal() {
    const title = document.getElementById('listeners-modal-title');
    const list = document.getElementById('listeners-modal-list');
    if (!title || !list) return;

    const listeners = getActiveListeners();
    const count = getListenerCount(listeners);
    title.textContent = count === 1 ? '1 person is listening now' : `${count} people are listening now`;

    const listenerRows = listeners.filter(user => !user.host);

    if (listenerRows.length === 0) {
        list.innerHTML = '<div class="listeners-empty">No listeners are connected right now.</div>';
        return;
    }

    list.innerHTML = listenerRows.map(user => `
        <div class="listener-row">
            <div class="listener-avatar" style="background: ${escapeAttr(user.avatarColor || '#1DB954')}">
                ${escapeHtml((user.username || '?').charAt(0).toUpperCase())}
            </div>
            <div class="listener-meta">
                <div class="listener-name">${escapeHtml(user.username || 'Unknown User')}${user.username === currentUser ? ' (You)' : ''}</div>
                <div class="listener-role">${user.host ? 'Host' : 'Listener'}</div>
            </div>
            ${user.host ? '<span class="listener-tag host">Host</span>' : '<span class="listener-tag">Live</span>'}
        </div>
    `).join('');
}

function openListenersModal() {
    const modal = document.getElementById('listeners-modal');
    if (!modal) return;

    renderListenersModal();
    modal.classList.remove('hidden');
}

function closeListenersModal() {
    const modal = document.getElementById('listeners-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

function handleListenersModalBackdrop(event) {
    if (event.target && event.target.id === 'listeners-modal') {
        closeListenersModal();
    }
}

function updateNowPlaying(song, playbackState) {
    if (!song || !song.title) {
        document.getElementById('song-title').textContent = 'No Song Playing';
        document.getElementById('song-artist').textContent = 'Add songs to the queue to start listening';
        document.getElementById('song-album').textContent = '';
        document.getElementById('album-cover-img').src = '';
        document.getElementById('no-song-placeholder').classList.remove('hidden');
        document.getElementById('now-playing-bg').style.backgroundImage = '';
        document.getElementById('sound-waves').classList.remove('active');
        stopProgressTimer();
        hideYtVideoPlayer();
        destroyYtPlayer();
        return;
    }

    const isVideoSong = isYouTubeMedia(song);

    if (playbackState && Number.isFinite(playbackState.currentSongIndex)) {
        const _newIdx = playbackState.currentSongIndex;
        if (_newIdx !== currentSongIndex) {
            nextSongSent = false;
        }
        currentSongIndex = _newIdx;
    }

    if (isVideoSong) {
        showYtVideoPlayer();
    } else {
        hideYtVideoPlayer();
        destroyYtPlayer();
    }

    document.getElementById('no-song-placeholder').classList.add('hidden');
    document.getElementById('song-title').textContent = song.title;
    document.getElementById('song-artist').textContent = song.artist;
    document.getElementById('song-album').textContent = song.album || '';
    document.getElementById('now-playing-bg').style.backgroundImage = `url(${song.coverUrl})`;
    if (!isVideoSong) {
        document.getElementById('album-cover-img').src = song.coverUrl || '';
    }

    duration = song.durationSeconds || 0;
    document.getElementById('time-total').textContent = formatTime(duration);

    if (playbackState) {
        updatePlayPauseIcon();

        if (isVideoSong) {
            isPlaying = !!playbackState.playing;
            currentTime = playbackState.currentTime || 0;
            stopAudioPlayback(false);
            const videoId = extractYouTubeId(song);

            const shouldLoadVideo = !ytPlayer || ytPlayerVideoId !== videoId;
            if (shouldLoadVideo) {
                loadYtVideo(videoId, currentTime, isPlaying);
            }

            if (isPlaying) {
                if (ytPlayer && typeof ytPlayer.playVideo === 'function' && !shouldLoadVideo) {
                    try { ytPlayer.playVideo(); } catch (e) { }
                }
                startProgressTimer();
                document.getElementById('sound-waves').classList.add('active');
            } else {
                if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
                    try { ytPlayer.pauseVideo(); } catch (e) { }
                }
                stopProgressTimer();
                document.getElementById('sound-waves').classList.remove('active');
            }
        } else {
            const currentAudioId = audioPlayer.getAttribute('data-song-id');
            const songChanged = !currentAudioId || currentAudioId !== song.id;

            if (song && songChanged) {
                audioPlayer.setAttribute('data-song-id', song.id);
                audioPlayer.removeAttribute('data-tried-direct-fallback');
                if (song.id && song.id.startsWith('jio_')) {
                    audioPlayer.src = '/api/music/stream/' + encodeURIComponent(song.id);
                } else {
                    audioPlayer.src = song.audioUrl || '';
                }
                audioPlayer.load();
            }

            isPlaying = !!playbackState.playing;
            currentTime = playbackState.currentTime || 0;

            if (songChanged && currentTime > 0) {
                audioPlayer.currentTime = currentTime;
            }

            if (isPlaying) {
                const playPromise = audioPlayer.play();
                if (playPromise !== undefined) {
                    playPromise.catch((err) => {
                        console.error('Failed to play audio:', err);
                        setTimeout(() => {
                            audioPlayer.play().catch(() => {
                                requestUserAudioResume();
                            });
                        }, 300);
                    });
                }
                startProgressTimer();
                document.getElementById('sound-waves').classList.add('active');
            } else {
                audioPlayer.pause();
                stopProgressTimer();
                document.getElementById('sound-waves').classList.remove('active');
            }
        }
        updateProgress();
    }
}

function updateQueue(queue, playbackState) {
    const queueList = document.getElementById('queue-list');
    const queueEmpty = document.getElementById('queue-empty');
    const queueCount = document.getElementById('queue-count');
    const currentIdx = playbackState ? playbackState.currentSongIndex : -1;

    queueCount.textContent = queue.length;

    if (queue.length === 0) {
        queueEmpty.classList.remove('hidden');
        queueList.innerHTML = '';
        return;
    }

    queueEmpty.classList.add('hidden');
    queueList.innerHTML = queue.map((song, index) => `
        <div class="song-item ${index === currentIdx ? 'playing' : ''}"
             data-index="${index}" data-song-id="${escapeAttr(song.id)}">
            <span class="song-item-drag" title="Drag to reorder">
                <i class="fas fa-grip-vertical"></i>
            </span>
            <span class="song-item-index">
                ${index === currentIdx && isPlaying
            ? '<i class="fas fa-volume-up" style="color: var(--accent); font-size: 12px;"></i>'
            : index + 1}
            </span>
            <img class="song-item-cover" draggable="false" src="${escapeAttr(song.coverUrl)}" alt="${escapeAttr(song.title)}">
            <div class="song-item-info">
                <div class="song-item-title">${escapeHtml(song.title)}</div>
                <div class="song-item-artist">${escapeHtml(song.artist)}</div>
            </div>
            ${song.addedBy ? `<span class="song-item-added">Added by ${escapeHtml(song.addedBy)}</span>` : ''}
            <span class="song-item-duration">${formatTime(song.durationSeconds)}</span>
            <button class="song-item-action song-item-playlist-btn" type="button" draggable="false" aria-label="Add ${escapeAttr(song.title)} to playlist" title="Add to playlist">
                <i class="fas fa-folder-plus"></i>
            </button>
            <button class="song-item-action remove" type="button" draggable="false" aria-label="Remove ${escapeAttr(song.title)} from queue" title="Remove from queue">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `).join('');

    // Attach all event listeners programmatically — avoids currentTarget/encoding issues
    queueList.querySelectorAll('.song-item').forEach(item => {
        const idx = parseInt(item.dataset.index);
        const songId = item.dataset.songId;
        const songObj = queue[idx];

        // Play on click
        item.addEventListener('click', () => playSongAtIndex(idx));

        // Add to playlist button
        const plBtn = item.querySelector('.song-item-playlist-btn');
        if (plBtn) {
            plBtn.addEventListener('pointerdown', e => e.stopPropagation());
            plBtn.addEventListener('dragstart', e => { e.preventDefault(); e.stopPropagation(); });
            plBtn.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                openAddToPlaylistModal(songObj || songId);
            });
        }

        // Remove button
        const removeBtn = item.querySelector('.song-item-action.remove');
        if (removeBtn) {
            removeBtn.addEventListener('pointerdown', e => {
                // Prevent drag start from the parent draggable row.
                e.stopPropagation();
            });
            removeBtn.addEventListener('dragstart', e => {
                e.preventDefault();
                e.stopPropagation();
            });
            removeBtn.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                removeFromQueue(songId);
            });
        }

        // Drag handle — prevent click from bubbling to play
        item.querySelector('.song-item-drag').addEventListener('click', e => e.stopPropagation());

        // Drag to reorder
        item.setAttribute('draggable', 'true');
        item.addEventListener('dragstart', e => {
            dragSrcIndex = idx;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(idx));
        });
        item.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const rect = item.getBoundingClientRect();
            item.classList.remove('drag-over-top', 'drag-over-bottom');
            item.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drag-over-top' : 'drag-over-bottom');
        });
        item.addEventListener('dragleave', () => {
            item.classList.remove('drag-over-top', 'drag-over-bottom');
        });
        item.addEventListener('drop', e => {
            e.preventDefault();
            item.classList.remove('drag-over-top', 'drag-over-bottom');
            if (dragSrcIndex !== null && dragSrcIndex !== idx) {
                reorderQueue(dragSrcIndex, idx);
            }
            dragSrcIndex = null;
        });
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            queueList.querySelectorAll('.song-item').forEach(el =>
                el.classList.remove('drag-over-top', 'drag-over-bottom')
            );
            dragSrcIndex = null;
        });
    });
}

// ===== Queue Drag & Drop =====
let dragSrcIndex = null;

// Legacy inline-handler stubs (kept for safety, not used in queue rendering)
function onQueueDragStart(e) { }
function onQueueDragOver(e) { e.preventDefault(); }
function onQueueDrop(e) { e.preventDefault(); }
function onQueueDragEnd(e) { }

function reorderQueue(fromIndex, toIndex) {
    waitForConnection(() => {
        socket.emit('room:queue:reorder', {
            roomCode: currentRoom.roomCode,
            fromIndex: fromIndex,
            toIndex: toIndex
        });
    });
}

function removeFromQueue(songId) {
    if (!songId || !currentRoom) {
        showToast('Unable to remove this song right now.', 'error');
        return;
    }

    if (socket && socket.connected) {
        socket.emit('room:queue:remove', {
            roomCode: currentRoom.roomCode,
            songId: songId,
            username: currentUser
        });
        showToast('Song removed from queue', 'success');
        return;
    }

    // Direct HTTP REST fallback
    fetch('/api/rooms/' + encodeURIComponent(currentRoom.roomCode) + '/queue/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ songId, username: currentUser })
    }).then(res => res.json()).then(data => {
        if (data.roomState) updateRoomUI(data.roomState);
        showToast('Song removed from queue', 'success');
        scheduleRoomStateRefresh(200);
    }).catch(err => {
        console.error('Remove queue HTTP error:', err);
    });
}

// ===== YouTube IFrame Video Player =====
let ytPlayer = null;
let ytPlayerVideoId = null;
let ytPlayerReady = false;
let ytPendingLoad = null;
let ytStateSyncSuppressUntil = 0;
const YT_STATE_SYNC_SUPPRESS_MS = 900;
const YT_SEEK_SYNC_FORWARD_THRESHOLD_SEC = 10;
const YT_SEEK_SYNC_BACKWARD_THRESHOLD_SEC = 3;
const YT_QUALITY_STEPS = ['large', 'medium', 'small'];
let ytQualityStepIndex = 1; // default to medium for smoother playback
let ytRecentBufferEvents = [];
let ytLastQualityChangeAt = 0;
let ytControlsHideTimeout = null;
let ytControlsBehaviorBound = false;
let ytLastBackgroundAt = 0;
const YT_BACKGROUND_PAUSE_GRACE_MS = 15000;
const YT_FORCE_PLAY_CHECK_MS = 100; // Check every 100ms - relentless
let ytUserPauseRequestedUntil = 0;
const YT_USER_PAUSE_INTENT_WINDOW_MS = 8000; // 8 second window for user pause
let ytUserPaused = false; // Set true when user explicitly pauses, cleared when they play

function clearYtControlsHideTimeout() {
    if (ytControlsHideTimeout) {
        clearTimeout(ytControlsHideTimeout);
        ytControlsHideTimeout = null;
    }
}

function setYtControlsVisible(visible) {
    const wrapper = document.getElementById('yt-video-wrapper');
    if (!wrapper) return;
    wrapper.classList.toggle('yt-controls-visible', !!visible);
}

function isTouchPrimaryInput() {
    return !!(window.matchMedia && window.matchMedia('(hover: none), (pointer: coarse)').matches);
}

function scheduleYtControlsHide(delayMs = 1400) {
    if (isTouchPrimaryInput()) return;
    clearYtControlsHideTimeout();
    ytControlsHideTimeout = window.setTimeout(() => {
        setYtControlsVisible(false);
    }, delayMs);
}

function showYtControlsTemporarily(delayMs = 1400) {
    setYtControlsVisible(true);
    scheduleYtControlsHide(delayMs);
}

function ensureYtControlsBehavior() {
    const wrapper = document.getElementById('yt-video-wrapper');
    if (!wrapper || ytControlsBehaviorBound) return;

    const revealControls = () => {
        showYtControlsTemporarily();
    };

    wrapper.addEventListener('mouseenter', revealControls);
    wrapper.addEventListener('mousemove', revealControls);
    wrapper.addEventListener('mouseleave', () => {
        clearYtControlsHideTimeout();
        setYtControlsVisible(false);
    });
    wrapper.addEventListener('touchstart', () => {
        showYtControlsTemporarily(2800);
    }, { passive: true });

    ytControlsBehaviorBound = true;
}

window.toggleYtFullscreen = function () {
    const wrapper = document.getElementById('yt-video-wrapper');
    if (!wrapper || wrapper.classList.contains('hidden')) return;

    showYtControlsTemporarily();

    const isCurrentlyFullscreen = !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.msFullscreenElement
    );

    if (isCurrentlyFullscreen) {
        const exitFullscreen = document.exitFullscreen
            || document.webkitExitFullscreen
            || document.msExitFullscreen;

        if (typeof exitFullscreen === 'function') {
            exitFullscreen.call(document);
        }
    } else {
        const requestFullscreen = wrapper.requestFullscreen
            || wrapper.webkitRequestFullscreen
            || wrapper.msRequestFullscreen;

        if (typeof requestFullscreen === 'function') {
            requestFullscreen.call(wrapper);
        } else {
            showToast('Fullscreen is not supported on this browser.', 'info');
        }
    }
};

// Listen for fullscreen changes (including Esc key) to restore normal view
document.addEventListener('fullscreenchange', handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
document.addEventListener('msfullscreenchange', handleFullscreenChange);

function handleFullscreenChange() {
    const isFullscreen = !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.msFullscreenElement
    );

    if (!isFullscreen) {
        showYtVideoPlayer();
        showYtControlsTemporarily(1800);
    }
}

window.changeYtQuality = function (quality) {
    if (!ytPlayer || !quality) return;
    try {
        showYtControlsTemporarily();
        ytPlayer.setPlaybackQuality(quality);
        showToast(`Quality set to ${quality.toUpperCase()}`, 'success');
    } catch (err) {
        showToast('Quality change failed or unavailable', 'error');
    }
};

window.toggleYtSubtitles = function () {
    if (!ytPlayer) return;
    try {
        showYtControlsTemporarily();
        const ccBtn = document.getElementById('yt-cc-btn');
        const tracksAvailable = ytPlayer.getVideoData().video_id && ytPlayer.getVideoData().video_id.length > 0;

        if (!tracksAvailable) {
            showToast('Subtitles not available for this video', 'error');
            return;
        }

        if (ccBtn && ccBtn.classList.contains('active')) {
            ytPlayer.unloadModule('captions');
            ccBtn.classList.remove('active');
            showToast('Subtitles disabled', 'success');
        } else {
            ytPlayer.loadModule('captions');
            if (ccBtn) ccBtn.classList.add('active');
            showToast('Subtitles enabled', 'success');
        }
    } catch (err) {
        showToast('Could not toggle subtitles', 'error');
    }
};

window.toggleYtEnlarge = function () {
    const wrapper = document.getElementById('yt-video-wrapper');
    if (!wrapper) return;

    const enlargeBtn = document.getElementById('yt-enlarge-btn');
    if (!enlargeBtn) return;

    if (wrapper.classList.contains('yt-enlarged')) {
        wrapper.classList.remove('yt-enlarged');
        enlargeBtn.classList.remove('active');
    } else {
        wrapper.classList.add('yt-enlarged');
        enlargeBtn.classList.add('active');
    }

    showYtControlsTemporarily();
};

function applyYtPreferredQuality(player) {
    if (!player) return;
    // Let YouTube auto-select quality based on network conditions
    // instead of forcing a specific level that may cause buffering
    try {
        if (typeof player.setPlaybackQualityRange === 'function') {
            player.setPlaybackQualityRange('small', 'large');
        }
    } catch (err) { }
}

function trackYtBufferingAndAdapt(player) {
    const now = Date.now();
    ytRecentBufferEvents.push(now);
    ytRecentBufferEvents = ytRecentBufferEvents.filter(t => (now - t) <= 15000);

    // If buffering repeats often, restrict max quality to stabilize playback.
    if (
        ytRecentBufferEvents.length >= 3
        && ytQualityStepIndex < YT_QUALITY_STEPS.length - 1
        && (now - ytLastQualityChangeAt) > 6000
    ) {
        ytQualityStepIndex += 1;
        ytLastQualityChangeAt = now;
        ytRecentBufferEvents = [];
        const maxQuality = YT_QUALITY_STEPS[Math.max(0, Math.min(ytQualityStepIndex, YT_QUALITY_STEPS.length - 1))];
        try {
            if (typeof player.setPlaybackQualityRange === 'function') {
                player.setPlaybackQualityRange('small', maxQuality);
            }
        } catch (err) { }
        showToast('Network is unstable. Lowered video quality for smoother playback.', 'info');
    }
}

function suppressYtStateSync(durationMs = YT_STATE_SYNC_SUPPRESS_MS) {
    const until = Date.now() + Math.max(0, durationMs || 0);
    if (until > ytStateSyncSuppressUntil) {
        ytStateSyncSuppressUntil = until;
    }
}

function isYtStateSyncSuppressed() {
    return Date.now() < ytStateSyncSuppressUntil;
}

function markYtBackgroundTransition() {
    ytLastBackgroundAt = Date.now();
}

function isLikelyBackgroundPause() {
    if (document.visibilityState === 'hidden') {
        return true;
    }

    const elapsed = Date.now() - ytLastBackgroundAt;
    return elapsed >= 0 && elapsed < YT_BACKGROUND_PAUSE_GRACE_MS;
}

function markYtUserPauseIntent(durationMs = YT_USER_PAUSE_INTENT_WINDOW_MS) {
    ytUserPauseRequestedUntil = Date.now() + Math.max(0, durationMs || 0);
}

function hasRecentYtUserPauseIntent() {
    return Date.now() < ytUserPauseRequestedUntil;
}

function shouldResyncYtTime(localTime, targetTime) {
    const local = Number(localTime) || 0;
    const target = Number(targetTime) || 0;
    const delta = target - local;

    // Only jump forward for very large drifts (likely explicit seek/select events).
    if (delta > YT_SEEK_SYNC_FORWARD_THRESHOLD_SEC) {
        return true;
    }

    // Rewind sooner when local player runs ahead of authoritative room time.
    if (delta < -YT_SEEK_SYNC_BACKWARD_THRESHOLD_SEC) {
        return true;
    }

    return false;
}

function maybeResumeYtAfterForeground() {
    if (!currentRoom || !Array.isArray(currentRoom.queue) || currentSongIndex < 0) return;

    const activeSong = currentRoom.queue[currentSongIndex];
    const isVideoSong = isYouTubeMedia(activeSong);
    if (!isVideoSong || !ytPlayer || !window.YT) return;

    // If user NOT pausing AND it's a video → always resume
    if (!ytUserPaused) {
        try {
            const state = ytPlayer.getPlayerState();
            if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) {
                console.log('[YouTube FOREGROUND] App active - user not pausing - RESUME!');
                suppressYtStateSync(2000);
                ytPlayer.playVideo();
                scheduleRoomStateRefresh(200);
            }
        } catch (err) {
            // Try anyway
            try { ytPlayer.playVideo(); } catch (e) { }
        }
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        markYtBackgroundTransition();
        return;
    }

    // App/tab came back to foreground - attempt to resume video
    console.log('[YouTube] Foreground detected - checking if resume is needed');
    window.setTimeout(maybeResumeYtAfterForeground, 100);
});

window.addEventListener('pagehide', markYtBackgroundTransition);

window.addEventListener('pageshow', () => {
    console.log('[YouTube] Page show event - attempting resume');
    window.setTimeout(maybeResumeYtAfterForeground, 150);
});

window.addEventListener('blur', () => {
    if (document.visibilityState !== 'visible') {
        markYtBackgroundTransition();
    }
});

// Mobile-specific: handle app resume events
window.addEventListener('focus', () => {
    // If window regains focus and we're still in background, this might be misleading
    // but we'll still try to resume as a failsafe
    if (currentRoom && currentRoom.playbackState && currentRoom.playbackState.playing) {
        console.log('[YouTube] Window focus event - checking video state');
        window.setTimeout(maybeResumeYtAfterForeground, 200);
    }
});

window.onYouTubeIframeAPIReady = function () {
    ytPlayerReady = true;
    if (ytPendingLoad) {
        const { videoId, startTime, autoplay } = ytPendingLoad;
        ytPendingLoad = null;
        _createYtPlayer(videoId, startTime, autoplay);
    }
};

function ensureYtApiLoaded() {
    if (window.YT && window.YT.Player) { ytPlayerReady = true; return; }
    if (document.getElementById('yt-iframe-api')) return;
    const tag = document.createElement('script');
    tag.id = 'yt-iframe-api';
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
}

function _createYtPlayer(videoId, startTime, autoplay) {
    const wrapper = document.getElementById('yt-video-wrapper');
    if (!wrapper) return;
    const existing = document.getElementById('yt-player');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.id = 'yt-player';
    wrapper.appendChild(div);

    ytPlayerVideoId = videoId;
    ytPlayer = new YT.Player('yt-player', {
        videoId: videoId,
        width: '100%',
        height: '100%',
        playerVars: {
            autoplay: autoplay ? 1 : 0,
            controls: 0,
            start: Math.floor(startTime || 0),
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            fs: 1,
            disablekb: 1,
            enablejsapi: 1,
            origin: window.location.origin
        },
        events: {
            onReady: (e) => {
                applyYtPreferredQuality(e.target);
                if (startTime > 0) {
                    suppressYtStateSync(1200);
                    e.target.seekTo(startTime, true);
                }
                if (autoplay) {
                    stopAudioPlayback(true);
                    suppressYtStateSync(1200);
                    e.target.playVideo();
                }
                else {
                    suppressYtStateSync(900);
                    e.target.pauseVideo();
                }
            },
            onStateChange: (e) => {
                if (e.data === YT.PlayerState.BUFFERING || e.data === YT.PlayerState.PLAYING) {
                    stopAudioPlayback(false);
                }

                if (e.data === YT.PlayerState.BUFFERING) {
                    trackYtBufferingAndAdapt(e.target);
                }

                const activeSong = currentRoom && Array.isArray(currentRoom.queue)
                    ? currentRoom.queue[currentSongIndex]
                    : null;
                const shouldSyncVideoState = isYouTubeMedia(activeSong);
                const stateSyncSuppressed = isYtStateSyncSuppressed();

                if (e.data === YT.PlayerState.ENDED) {
                    // Don't send next if user just clicked next/previous to avoid double-advance
                    if (Date.now() - _lastUserMove < 5000) return;
                    sendPlaybackCommand('next', 0);
                } else if (e.data === YT.PlayerState.PLAYING) {
                    const wasPlaying = isPlaying;
                    isPlaying = true;
                    updatePlayPauseIcon();
                    startProgressTimer();
                    document.getElementById('sound-waves').classList.add('active');

                    // If playback changed from a direct click inside the iframe,
                    // sync that state to the room so it doesn't auto-resume unexpectedly.
                    if (shouldSyncVideoState && !stateSyncSuppressed && !wasPlaying) {
                        let videoTime = 0;
                        try { videoTime = e.target.getCurrentTime() || 0; } catch (err) { }
                        sendPlaybackCommand('play', videoTime);
                    }
                } else if (e.data === YT.PlayerState.PAUSED) {
                    const wasPlaying = isPlaying;
                    const recentlyBackgrounded = Date.now() - ytLastBackgroundAt < 15000;

                    console.log('[YouTube PAUSE] ytUserPaused:', ytUserPaused, '| recentlyBackgrounded:', recentlyBackgrounded, '| wasPlaying:', wasPlaying);

                    // === ONLY force-play if this is a known system/tab-background pause ===
                    if (recentlyBackgrounded && wasPlaying) {
                        // System pause from tab background, or YT internal state → force play
                        console.log('[YouTube] ⚠️ SYSTEM/BACKGROUND PAUSE - FORCING RESUME');
                        suppressYtStateSync(3000);

                        try {
                            if (ytPlayer && typeof ytPlayer.playVideo === 'function') {
                                for (let i = 0; i < 8; i++) {
                                    ytPlayer.playVideo();
                                    setTimeout(() => { try { ytPlayer.playVideo(); } catch (e) { } }, i * 10);
                                }
                                console.log('[YouTube] FORCED PLAY - video will not pause');
                            }
                        } catch (err) { }

                        return;
                    }

                    // === ALL OTHER PAUSES: RESPECT (user clicked app button, YT video directly, etc.) ===
                    console.log('[YouTube] ✓ Respecting pause');
                    ytUserPaused = true;
                    isPlaying = false;
                    updatePlayPauseIcon();
                    stopProgressTimer();
                    document.getElementById('sound-waves').classList.remove('active');

                    if (shouldSyncVideoState && !stateSyncSuppressed && wasPlaying) {
                        let videoTime = 0;
                        try { videoTime = e.target.getCurrentTime() || 0; } catch (err) { }
                        sendPlaybackCommand('pause', videoTime);
                    }
                    return;
                }
            },
            onError: (e) => {
                const code = e && typeof e.data !== 'undefined' ? e.data : 'unknown';
                console.warn('[YouTube] Player error for video', videoId, 'code:', code);
                showToast('This YouTube video cannot be played here. Try another video result.', 'error');
                isPlaying = false;
                updatePlayPauseIcon();
                stopProgressTimer();
                document.getElementById('sound-waves').classList.remove('active');
            }
        }
    });
}

function loadYtVideo(videoId, startTime, autoplay) {
    stopAudioPlayback(true);
    ensureYtApiLoaded();
    if (!ytPlayerReady || !window.YT || !window.YT.Player) {
        ytPendingLoad = { videoId, startTime, autoplay };
        return;
    }
    if (ytPlayer && ytPlayerVideoId === videoId) {
        try {
            const desiredTime = Number.isFinite(Number(startTime)) ? Number(startTime) : 0;
            const localTime = ytPlayer.getCurrentTime() || 0;
            if (shouldResyncYtTime(localTime, desiredTime)) {
                suppressYtStateSync(1100);
                ytPlayer.seekTo(desiredTime, true);
            }

            const playerState = typeof ytPlayer.getPlayerState === 'function'
                ? ytPlayer.getPlayerState()
                : null;

            if (autoplay) {
                if (playerState !== YT.PlayerState.PLAYING && playerState !== YT.PlayerState.BUFFERING) {
                    suppressYtStateSync(900);
                    ytPlayer.playVideo();
                }
            } else if (playerState === YT.PlayerState.PLAYING || playerState === YT.PlayerState.BUFFERING) {
                suppressYtStateSync(900);
                ytPlayer.pauseVideo();
            }
        } catch (e) { }
        return;
    }

    if (ytPlayer && typeof ytPlayer.loadVideoById === 'function' && ytPlayerReady) {
        try {
            ytPlayerVideoId = videoId;
            suppressYtStateSync(1200);
            if (autoplay) {
                ytPlayer.loadVideoById({
                    videoId: videoId,
                    startSeconds: Number.isFinite(Number(startTime)) ? Number(startTime) : 0
                });
            } else {
                ytPlayer.cueVideoById({
                    videoId: videoId,
                    startSeconds: Number.isFinite(Number(startTime)) ? Number(startTime) : 0
                });
            }
            return;
        } catch (e) {
            console.warn('[YouTube] Fast loadVideoById failed, creating new player:', e);
        }
    }

    _createYtPlayer(videoId, startTime, autoplay);
}

function destroyYtPlayer() {
    if (ytPlayer) {
        try { ytPlayer.destroy(); } catch (e) { }
        ytPlayer = null;
        ytPlayerVideoId = null;
    }
    const wrapper = document.getElementById('yt-video-wrapper');
    if (wrapper) {
        const existing = document.getElementById('yt-player');
        if (existing) existing.remove();
        const div = document.createElement('div');
        div.id = 'yt-player';
        wrapper.appendChild(div);
    }
}

function showYtVideoPlayer() {
    const wrapper = document.getElementById('yt-video-wrapper');
    if (wrapper) {
        const wasHidden = wrapper.classList.contains('hidden');
        wrapper.classList.remove('hidden');
        ensureYtControlsBehavior();
        if (wasHidden) {
            showYtControlsTemporarily(1800);
        }
    }
    const artwork = document.getElementById('album-artwork');
    if (artwork) artwork.classList.add('hidden');
    const roomMain = document.querySelector('.room-main');
    if (roomMain) roomMain.classList.add('yt-video-mode');
    const nowPlayingContent = document.querySelector('.now-playing-content');
    if (nowPlayingContent) nowPlayingContent.classList.add('yt-video-mode');
    const nowPlayingSection = document.querySelector('.now-playing-section');
    if (nowPlayingSection) nowPlayingSection.classList.add('yt-video-active');
}

function hideYtVideoPlayer() {
    const wrapper = document.getElementById('yt-video-wrapper');
    if (wrapper) {
        wrapper.classList.add('hidden');
        wrapper.classList.remove('yt-controls-visible');
    }
    clearYtControlsHideTimeout();
    const artwork = document.getElementById('album-artwork');
    if (artwork) artwork.classList.remove('hidden');
    const roomMain = document.querySelector('.room-main');
    if (roomMain) roomMain.classList.remove('yt-video-mode');
    const nowPlayingContent = document.querySelector('.now-playing-content');
    if (nowPlayingContent) nowPlayingContent.classList.remove('yt-video-mode');
    const nowPlayingSection = document.querySelector('.now-playing-section');
    if (nowPlayingSection) nowPlayingSection.classList.remove('yt-video-active');
}

// ===== External Search (YouTube Music + YouTube Videos) =====
const songMetadataStore = new Map();
let localTransitionTargetIndex = null;
let localTransitionTimestamp = 0;
const LOCAL_TRANSITION_LOCK_MS = 2500;
let searchTimeout = null;
let _allSearchResults = []; // cache last results for filter re-render
let _activeFilters = new Set(['jiosaavn']);
let isYouTubeConfigured = true;
let currentSearchResultTab = 'songs';
const searchViewHistory = [];

function setSingleActiveSource(source) {
    let target = source;
    if (!target || (target !== 'jiosaavn' && target !== 'youtube' && target !== 'youtubevideo')) {
        target = Array.from(_activeFilters)[0] || 'jiosaavn';
    }
    if (!isYouTubeConfigured && (target === 'youtube' || target === 'youtubevideo')) {
        target = Array.from(_activeFilters)[0] || 'jiosaavn';
    }
    _activeFilters = new Set([target]);
    return target;
}

function cloneSearchResults(results) {
    if (!Array.isArray(results)) return [];

    return results.map(song => {
        const cloned = { ...song };

        // Normalize duration from mixed payload shapes (number, string, or alternate fields).
        const rawDuration = cloned.durationSeconds ?? cloned.duration ?? cloned.lengthSeconds ?? cloned.lengthText;
        cloned.durationSeconds = normalizeDurationSeconds(rawDuration);

        return cloned;
    });
}

function normalizeDurationSeconds(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.floor(value));
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return 0;

        if (/^\d+$/.test(trimmed)) {
            return Math.max(0, parseInt(trimmed, 10));
        }

        const clockMatch = trimmed.match(/(?:\d{1,2}:)?\d{1,2}:\d{2}/);
        if (clockMatch) {
            return clockMatch[0].split(':').reduce((total, part) => {
                const n = parseInt(part, 10);
                if (Number.isNaN(n)) return total;
                return (total * 60) + n;
            }, 0);
        }
    }

    return 0;
}

function getFilteredSearchResults(results = _allSearchResults) {
    return (Array.isArray(results) ? results : []).filter(song => {
        if (song.id && song.id.startsWith('jio_')) return _activeFilters.has('jiosaavn');
        if (song.id && song.id.startsWith('ytv_')) return _activeFilters.has('youtubevideo');
        if (song.id && song.id.startsWith('yt_')) return _activeFilters.has('youtube');
        return true;
    });
}

function renderEmptyFilteredResults(resultsList) {
    resultsList.innerHTML = `<div class="search-no-results">
        <i class="fas fa-filter" style="font-size:2rem;color:#666;margin-bottom:.5rem"></i>
        <p>No results for the selected source.</p>
        <p style="font-size:.8rem;color:#888">Select a different source above to see results.</p>
    </div>`;
}

function updateSourceFilterButtons(hasYouTube = false, hasYouTubeVideo = false, hasJio = false) {
    const jioBtn = document.getElementById('filter-jiosaavn');
    const youTubeBtn = document.getElementById('filter-youtube');
    const ytvBtn = document.getElementById('filter-youtubevideo');
    if (jioBtn) {
        jioBtn.classList.toggle('active', _activeFilters.has('jiosaavn'));
        jioBtn.classList.toggle('has-results', !!hasJio);
    }
    if (youTubeBtn) {
        youTubeBtn.classList.toggle('disabled', !isYouTubeConfigured);
        youTubeBtn.classList.toggle('active', _activeFilters.has('youtube'));
        youTubeBtn.classList.toggle('has-results', !!hasYouTube);
    }
    if (ytvBtn) {
        ytvBtn.classList.toggle('disabled', !isYouTubeConfigured);
        ytvBtn.classList.toggle('active', _activeFilters.has('youtubevideo'));
        ytvBtn.classList.toggle('has-results', !!hasYouTubeVideo);
    }
}

function buildSearchViewSnapshot(mode) {
    const input = document.getElementById('external-search');
    const youTubeBtn = document.getElementById('filter-youtube');
    const ytvBtn = document.getElementById('filter-youtubevideo');
    return {
        mode,
        query: input ? input.value : '',
        allResults: cloneSearchResults(_allSearchResults),
        activeFilters: Array.from(_activeFilters),
        currentResultTab: currentSearchResultTab,
        hasYouTube: !!youTubeBtn && youTubeBtn.classList.contains('has-results'),
        hasYouTubeVideo: !!ytvBtn && ytvBtn.classList.contains('has-results')
        , hasJio: !!document.getElementById('filter-jiosaavn') && document.getElementById('filter-jiosaavn').classList.contains('has-results')
    };
}

function rememberSearchView(mode) {
    const snapshot = buildSearchViewSnapshot(mode);
    const last = searchViewHistory[searchViewHistory.length - 1];
    if (
        last
        && last.mode === snapshot.mode
        && last.query === snapshot.query
        && last.currentResultTab === snapshot.currentResultTab
        && last.hasYouTube === snapshot.hasYouTube
        && last.activeFilters.join('|') === snapshot.activeFilters.join('|')
        && last.allResults.length === snapshot.allResults.length
    ) {
        return;
    }
    searchViewHistory.push(snapshot);
}

function restoreSearchView(snapshot) {
    const input = document.getElementById('external-search');
    const statusEl = document.getElementById('search-status');
    const emptyEl = document.getElementById('search-empty');
    const resultsList = document.getElementById('search-results');

    if (input) input.value = snapshot.query || '';
    if (statusEl) statusEl.classList.add('hidden');

    currentSearchResultTab = snapshot.currentResultTab || 'songs';
    const preferredSource = Array.isArray(snapshot.activeFilters) && snapshot.activeFilters.length > 0
        ? snapshot.activeFilters[0]
        : 'jiosaavn';
    setSingleActiveSource(preferredSource);

    if (snapshot.mode === 'results') {
        _allSearchResults = cloneSearchResults(snapshot.allResults);
        if (emptyEl) emptyEl.classList.add('hidden');
        updateSourceFilterButtons(snapshot.hasYouTube, snapshot.hasYouTubeVideo, snapshot.hasJio);
        if (resultsList) {
            const filtered = getFilteredSearchResults(_allSearchResults);
            if (filtered.length === 0) {
                renderEmptyFilteredResults(resultsList);
            } else {
                renderSearchResults(filtered);
            }
        }
    } else {
        _allSearchResults = [];
        currentSearchResultTab = 'songs';
        if (resultsList) resultsList.innerHTML = '';
        if (emptyEl) emptyEl.classList.remove('hidden');
        updateSourceFilterButtons(false, false, false);
    }

    _updateSearchBackBtn();
}

window.toggleSourceFilter = function (source) {
    const btn = document.getElementById('filter-' + source);
    if (!btn) return;

    if ((source === 'youtube' || source === 'youtubevideo') && !isYouTubeConfigured) {
        showToast('YouTube source is currently unavailable on server.', 'info');
        return;
    }

    const selected = setSingleActiveSource(source);
    if (selected !== source) return;

    const hasYT = _allSearchResults.some(song => song.id.startsWith('yt_'));
    const hasYTV = _allSearchResults.some(song => song.id.startsWith('ytv_'));
    const hasJio = _allSearchResults.some(song => song.id && song.id.startsWith('jio_'));
    updateSourceFilterButtons(hasYT, hasYTV, hasJio);
    if (_allSearchResults.length > 0) {
        const filtered = getFilteredSearchResults(_allSearchResults);
        const resultsList = document.getElementById('search-results');
        if (filtered.length === 0) {
            renderEmptyFilteredResults(resultsList);
        } else {
            renderSearchResults(filtered);
        }
    }
};

async function searchExternal(preserveCurrentView = true) {
    await checkSources();

    const input = document.getElementById('external-search');
    const query = input.value.trim();
    if (!query) {
        showToast('Please enter a search query', 'info');
        return;
    }

    const statusEl = document.getElementById('search-status');
    const emptyEl = document.getElementById('search-empty');
    const resultsList = document.getElementById('search-results');

    if (preserveCurrentView && document.querySelector('#tab-search.active')) {
        if (_allSearchResults.length > 0) {
            rememberSearchView('results');
        } else if (emptyEl && !emptyEl.classList.contains('hidden')) {
            rememberSearchView('suggestions');
        }
    }

    _allSearchResults = [];
    currentSearchResultTab = 'songs';
    statusEl.classList.remove('hidden');
    emptyEl.classList.add('hidden');
    resultsList.innerHTML = '';
    const searchBackBtn = document.getElementById('search-back-btn');
    if (searchBackBtn) searchBackBtn.classList.add('hidden');

    try {
        const res = await fetch('/api/music/search/external?q=' + encodeURIComponent(query) + '&limit=200');
        if (!res.ok) throw new Error('Search failed');
        const payload = await res.json();

        const jioSongs = Array.isArray(payload)
            ? payload.filter(song => song && song.id && song.id.startsWith('jio_'))
            : (Array.isArray(payload.jioSaavn) ? payload.jioSaavn : []);
        const ytMusicSongs = Array.isArray(payload)
            ? payload.filter(song => song && song.id && song.id.startsWith('yt_'))
            : (Array.isArray(payload.youTubeMusic) ? payload.youTubeMusic : []);
        const ytVideoSongs = Array.isArray(payload)
            ? payload.filter(song => song && song.id && song.id.startsWith('ytv_'))
            : (Array.isArray(payload.youTubeVideos) ? payload.youTubeVideos : []);
        const songs = [...jioSongs, ...ytMusicSongs, ...ytVideoSongs];
        songs.forEach(s => { if (s && s.id) songMetadataStore.set(s.id, s); });

        statusEl.classList.add('hidden');

        if (songs.length === 0) {
            resultsList.innerHTML = `
                <div class="search-no-results">
                    <i class="fas fa-search" style="font-size: 2rem; color: #666; margin-bottom: 0.5rem;"></i>
                    <p>No results found for "${escapeHtml(query)}"</p>
                    <p style="font-size: 0.8rem; color: #888;">Try different keywords or check spelling</p>
                </div>`;
            return;
        }

        _allSearchResults = cloneSearchResults(songs);
        updateSourceFilterButtons(
            ytMusicSongs.length > 0,
            ytVideoSongs.length > 0,
            jioSongs.length > 0
        );

        const filtered = getFilteredSearchResults(_allSearchResults);
        if (filtered.length === 0) {
            renderEmptyFilteredResults(resultsList);
        } else {
            renderSearchResults(filtered);
        }
        _updateSearchBackBtn();
    } catch (e) {
        statusEl.classList.add('hidden');
        showToast('Search failed: ' + e.message, 'error');
        console.error('External search failed:', e);
    }
}

window.clearSearch = function () {
    _allSearchResults = [];
    currentSearchResultTab = 'songs';
    searchViewHistory.length = 0;
    const input = document.getElementById('external-search');
    if (input) input.value = '';
    const resultsList = document.getElementById('search-results');
    if (resultsList) resultsList.innerHTML = '';
    const emptyEl = document.getElementById('search-empty');
    if (emptyEl) emptyEl.classList.remove('hidden');
    updateSourceFilterButtons(false, false, false);
    if (input) input.focus();
    _updateSearchBackBtn();
};

function quickSearch(query) {
    document.getElementById('external-search').value = query;
    searchExternal(true);
}

function renderSearchResults(songs) {
    if (Array.isArray(songs)) {
        songs.forEach(s => { if (s && s.id) songMetadataStore.set(s.id, s); });
    }
    const list = document.getElementById('search-results');
    const fallbackImg = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2260%22 height=%2260%22><rect fill=%22%23333%22 width=%2260%22 height=%2260%22/><text x=%2230%22 y=%2236%22 fill=%22%23888%22 text-anchor=%22middle%22 font-size=%2224%22>♪</text></svg>";

    // Collect unique artists and albums
    const artistMap = new Map();
    const albumMap = new Map();
    songs.forEach(song => {
        const artistName = (song.artist || '').trim();
        if (artistName && artistName !== 'Unknown Artist') {
            if (!artistMap.has(artistName)) {
                artistMap.set(artistName, { name: artistName, cover: song.coverUrl, count: 0 });
            }
            artistMap.get(artistName).count++;
        }
        const albumName = (song.album || '').trim();
        if (albumName) {
            const key = albumName + '||' + artistName;
            if (!albumMap.has(key)) {
                albumMap.set(key, { name: albumName, artist: artistName, cover: song.coverUrl, count: 0 });
            }
            albumMap.get(key).count++;
        }
    });

    const activeResultTab = ['songs', 'artists', 'albums'].includes(currentSearchResultTab)
        ? currentSearchResultTab
        : 'songs';

    // ── Tab bar ───────────────────────────────────────────────
    let html = `<div class="sr-tabs">
        <button class="sr-tab${activeResultTab === 'songs' ? ' active' : ''}" data-tab="songs" onclick="switchSearchTab('songs')">
            <i class="fas fa-music"></i> Songs <span class="sr-tab-count">${songs.length}</span>
        </button>
        <button class="sr-tab${activeResultTab === 'artists' ? ' active' : ''}" data-tab="artists" onclick="switchSearchTab('artists')">
            <i class="fas fa-user"></i> Artists <span class="sr-tab-count">${artistMap.size}</span>
        </button>
        <button class="sr-tab${activeResultTab === 'albums' ? ' active' : ''}" data-tab="albums" onclick="switchSearchTab('albums')">
            <i class="fas fa-record-vinyl"></i> Albums <span class="sr-tab-count">${albumMap.size}</span>
        </button>
    </div>`;

    // ── Songs panel ───────────────────────────────────────────
    html += `<div class="sr-panel${activeResultTab === 'songs' ? '' : ' hidden'}" id="sr-panel-songs">`;
    html += songs.map(song => {
        const sourceIcon = song.id && song.id.startsWith('jio_')
            ? '<span class="source-tag jio">JioSaavn</span>'
            : song.id && song.id.startsWith('ytv_')
                ? '<span class="source-tag yt">Video Song</span>'
                : song.id && song.id.startsWith('yt_')
                    ? '<span class="source-tag yt">YouTube Music</span>'
                    : '';
        const albumPart = song.album ? ` <span class="song-meta-album"><i class="fas fa-compact-disc"></i> ${escapeHtml(song.album)}</span>` : '';
        return `
        <div class="song-item" onclick="playSongNow('${escapeAttr(song.id)}')" title="Click to play now">
            <div class="song-item-cover-wrapper">
                <img class="song-item-cover" src="${escapeAttr(song.coverUrl)}" alt="${escapeAttr(song.title)}"
                     onerror="this.src='${fallbackImg}'">
                <div class="song-item-hover-play"><i class="fas fa-play"></i></div>
            </div>
            <div class="song-item-info">
                <div class="song-item-title">${escapeHtml(song.title)}</div>
                <div class="song-item-meta">
                    <span class="song-meta-artist"><i class="fas fa-user"></i> ${escapeHtml(song.artist)}</span>${albumPart}
                </div>
            </div>
            ${sourceIcon}
            <span class="song-item-duration">${formatTime(song.durationSeconds)}</span>
            <button class="song-item-action song-item-playlist-btn" data-song-id="${escapeAttr(song.id)}" onclick="event.stopPropagation(); openAddToPlaylistModal('${escapeAttr(song.id)}')" title="Add to Playlist">
                <i class="fas fa-folder-plus"></i>
            </button>
            <button class="song-item-action" data-song-id="${escapeAttr(song.id)}" onclick="event.stopPropagation(); addToQueue('${escapeAttr(song.id)}')" title="Add to queue">
                <i class="fas fa-plus"></i>
            </button>
        </div>`;
    }).join('');
    html += `</div>`;

    // ── Artists panel ─────────────────────────────────────────
    html += `<div class="sr-panel${activeResultTab === 'artists' ? '' : ' hidden'}" id="sr-panel-artists">`;
    if (artistMap.size === 0) {
        html += `<div class="sr-panel-empty"><i class="fas fa-user-slash"></i><p>No artists found</p></div>`;
    } else {
        html += `<div class="sr-grid">`;
        artistMap.forEach(a => {
            html += `<div class="sr-card sr-artist-card" onclick="quickSearch('${escapeAttr(a.name)}')" title="Search songs by ${escapeAttr(a.name)}">
                <div class="sr-card-img-wrap sr-artist-img">
                    <img src="${escapeAttr(a.cover)}" alt="${escapeAttr(a.name)}" onerror="this.src='${fallbackImg}'">
                    <div class="sr-card-overlay"><i class="fas fa-search"></i></div>
                </div>
                <div class="sr-card-body">
                    <div class="sr-card-title">${escapeHtml(a.name)}</div>
                    <div class="sr-card-sub">${a.count} song${a.count !== 1 ? 's' : ''}</div>
                </div>
            </div>`;
        });
        html += `</div>`;
    }
    html += `</div>`;

    // ── Albums panel ──────────────────────────────────────────
    html += `<div class="sr-panel${activeResultTab === 'albums' ? '' : ' hidden'}" id="sr-panel-albums">`;
    if (albumMap.size === 0) {
        html += `<div class="sr-panel-empty"><i class="fas fa-compact-disc"></i><p>No albums found</p></div>`;
    } else {
        html += `<div class="sr-grid">`;
        albumMap.forEach(al => {
            html += `<div class="sr-card sr-album-card" onclick="quickSearch('${escapeAttr(al.name)}')" title="Search songs from ${escapeAttr(al.name)}">
                <div class="sr-card-img-wrap">
                    <img src="${escapeAttr(al.cover)}" alt="${escapeAttr(al.name)}" onerror="this.src='${fallbackImg}'">
                    <div class="sr-card-overlay"><i class="fas fa-search"></i></div>
                </div>
                <div class="sr-card-body">
                    <div class="sr-card-title">${escapeHtml(al.name)}</div>
                    <div class="sr-card-sub">${escapeHtml(al.artist)}</div>
                </div>
            </div>`;
        });
        html += `</div>`;
    }
    html += `</div>`;

    list.innerHTML = html;
}

window.switchSearchTab = function (tab, pushHistory = true) {
    if (pushHistory && _allSearchResults.length > 0 && currentSearchResultTab && currentSearchResultTab !== tab) {
        rememberSearchView('results');
    }
    currentSearchResultTab = tab;
    document.querySelectorAll('.sr-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.sr-panel').forEach(panel => {
        panel.classList.toggle('hidden', !panel.id.endsWith(tab));
    });
    _updateSearchBackBtn();
};

async function checkSources() {
    try {
        const res = await fetch('/api/music/sources');
        const data = await res.json();
        isYouTubeConfigured = !!(data.youtubeConfigured || data.youtube);

        setSingleActiveSource(Array.from(_activeFilters)[0] || 'jiosaavn');

        const hasYouTubeInResults = _allSearchResults.some(song => song.id && song.id.startsWith('yt_'));
        const hasYouTubeVideoInResults = _allSearchResults.some(song => song.id && song.id.startsWith('ytv_'));
        const hasJioInResults = _allSearchResults.some(song => song.id && song.id.startsWith('jio_'));
        updateSourceFilterButtons(hasYouTubeInResults, hasYouTubeVideoInResults, hasJioInResults);

        if (_allSearchResults.length > 0) {
            const resultsList = document.getElementById('search-results');
            const filtered = getFilteredSearchResults(_allSearchResults);
            if (filtered.length === 0) {
                renderEmptyFilteredResults(resultsList);
            } else {
                renderSearchResults(filtered);
            }
        }
    } catch (e) {
        console.log('Could not check sources:', e);
    }
}

const pendingAddSongs = new Set();

function playSongNow(songId) {
    console.log('[playSongNow] called with songId:', songId);
    if (!currentRoom) { showToast('Join a room first', 'error'); return; }

    unlockAudio().catch(() => { });

    // Check if song is already in queue
    const queue = Array.isArray(currentRoom.queue) ? currentRoom.queue : [];
    const existingIndex = queue.findIndex(s => s && s.id === songId);
    if (existingIndex >= 0) {
        playSongAtIndex(existingIndex);
        showToast('Playing song from queue', 'info');
        return;
    }

    const selectedSong = songMetadataStore.get(songId)
        || (Array.isArray(_allSearchResults) ? _allSearchResults.find(s => s && s.id === songId) : null);

    // Instant tactile feedback on add button
    const btn = document.querySelector(`button.song-item-action[data-song-id="${songId}"]`);
    if (btn) {
        btn.classList.add('added');
        btn.innerHTML = '<i class="fas fa-play"></i>';
    }

    if (!socket || !socket.connected) {
        pendingAddSongs.add(songId);
        showToast('Connecting... song will play shortly.', 'info');
        waitForConnection(() => {
            pendingAddSongs.delete(songId);
            sendAddToQueue(songId, true);
        });
        return;
    }
    sendAddToQueue(songId, true);
}
window.playSongNow = playSongNow;

function addToQueue(songId) {
    console.log('[addToQueue] called with songId:', songId, '| connected:', !!(socket && socket.connected), '| currentRoom:', !!currentRoom);
    if (!currentRoom) { showToast('Join a room first', 'error'); return; }

    unlockAudio().catch(() => { });

    // Instant tactile feedback on add button
    const btn = document.querySelector(`button.song-item-action[data-song-id="${songId}"]`)
        || document.querySelector(`button[data-song-id="${songId}"]`)
        || (typeof event !== 'undefined' && event && event.target && event.target.closest('.song-item-action'));
    if (btn) {
        btn.classList.add('added');
        btn.innerHTML = '<i class="fas fa-check"></i>';
    }
    const qc = document.getElementById('queue-count');
    if (qc) {
        const cur = parseInt(qc.textContent, 10) || 0;
        qc.textContent = cur + 1;
    }

    const playImmediately = (!currentRoom.queue || currentRoom.queue.length === 0);

    sendAddToQueue(songId, playImmediately);
}
window.addToQueue = addToQueue;

async function sendAddToQueue(songId, playImmediately = false) {
    const selectedSong = songMetadataStore.get(songId)
        || (Array.isArray(_allSearchResults) ? _allSearchResults.find(s => s && s.id === songId) : null);

    const payload = {
        roomCode: currentRoom.roomCode,
        songId: songId,
        username: currentUser,
        title: selectedSong ? selectedSong.title : undefined,
        artist: selectedSong ? selectedSong.artist : undefined,
        album: selectedSong ? selectedSong.album : undefined,
        coverUrl: selectedSong ? selectedSong.coverUrl : undefined,
        durationSeconds: selectedSong ? (selectedSong.durationSeconds || 0) : 0,
        audioUrl: selectedSong ? selectedSong.audioUrl : undefined,
        playImmediately: !!playImmediately
    };

    if (socket && socket.connected) {
        try {
            socket.emit('room:queue:add', payload);
            showToast(playImmediately ? 'Playing song now!' : 'Song added to queue!', 'success');
            return;
        } catch (err) {
            console.warn('[addToQueue] Socket emit failed, using HTTP fallback:', err);
        }
    }

    // Direct HTTP REST fallback when WebSocket is not connected or in serverless mode
    try {
        const res = await fetch('/api/rooms/' + encodeURIComponent(currentRoom.roomCode) + '/queue/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || 'Failed to add song');
        }

        const data = await res.json();
        if (data.roomState) {
            updateRoomUI(data.roomState);
        }
        showToast(playImmediately ? 'Playing song now!' : 'Song added to queue!', 'success');
        scheduleRoomStateRefresh(200);
    } catch (err) {
        console.error('AddToQueue HTTP error:', err);
        showToast('Failed to add song. Check connection.', 'error');
    }
}

// ===== Playback Controls =====
function togglePlayPause() {
    if (!currentRoom || !currentRoom.queue || currentRoom.queue.length === 0) {
        showToast('Add songs to the queue first', 'info');
        return;
    }

    if (currentSongIndex < 0 && currentRoom.queue.length > 0) {
        currentSongIndex = 0;
    }

    const currentSong = currentRoom.queue[currentSongIndex];
    const isVideoSong = isYouTubeMedia(currentSong);
    let ct = 0;
    if (isVideoSong && ytPlayer) {
        try { ct = ytPlayer.getCurrentTime() || 0; } catch (e) { }
    } else {
        ct = audioPlayer.currentTime || currentTime;
    }

    isPlaying = !isPlaying;
    updatePlayPauseIcon();

    if (isVideoSong && currentSong) {
        const videoId = extractYouTubeId(currentSong);
        if (isPlaying) {
            ytUserPaused = false;
            loadYtVideo(videoId, ct, true);
            try {
                if (ytPlayer && typeof ytPlayer.playVideo === 'function') {
                    suppressYtStateSync(1000);
                    ytPlayer.playVideo();
                }
            } catch (err) {
                console.warn('[YouTube] Local play trigger failed:', err);
            }
        } else {
            ytUserPaused = true;
            // If player hasn't loaded yet, cancel the pending autoplay
            if (ytPendingLoad) {
                ytPendingLoad.autoplay = false;
            }
            try {
                if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
                    markYtUserPauseIntent();
                    suppressYtStateSync(1000);
                    ytPlayer.pauseVideo();
                }
            } catch (err) {
                console.warn('[YouTube] Local pause trigger failed:', err);
            }
        }
    } else if (currentSong && !isVideoSong) {
        if (isPlaying) {
            if (!audioPlayer.src || audioPlayer.src === window.location.href) {
                if (currentSong.id && currentSong.id.startsWith('jio_')) {
                    audioPlayer.src = '/api/music/stream/' + encodeURIComponent(currentSong.id);
                } else if (currentSong.audioUrl) {
                    audioPlayer.src = currentSong.audioUrl;
                }
                audioPlayer.load();
            }
            const p = audioPlayer.play();
            if (p) p.catch(function (err) {
                console.error('[Audio] play failed:', err);
                requestUserAudioResume();
            });
            startProgressTimer();
            document.getElementById('sound-waves').classList.add('active');
        } else {
            audioPlayer.pause();
            stopProgressTimer();
            document.getElementById('sound-waves').classList.remove('active');
        }
    }

    sendPlaybackCommand(isPlaying ? 'play' : 'pause', ct);
}

function nextSong() {
    if (!currentRoom || !Array.isArray(currentRoom.queue) || currentRoom.queue.length === 0) {
        showToast('No songs in queue', 'info');
        return;
    }
    var nextIdx = currentSongIndex + 1;
    if (nextIdx >= currentRoom.queue.length) {
        showToast('No next song - end of queue', 'info');
        return;
    }
    currentSongIndex = nextIdx;
    localTransitionTargetIndex = nextIdx;
    localTransitionTimestamp = Date.now();
    var song = currentRoom.queue[nextIdx];
    isPlaying = true;
    updatePlayPauseIcon();
    nextSongSent = false; // Reset for new song
    updateNowPlaying(song, { playing: true, currentSongIndex: nextIdx, currentTime: 0 });
    startProgressTimer();
    document.getElementById('sound-waves').classList.add('active');
    _lastUserMove = Date.now();
    sendPlaybackCommand('next', 0);
}

function previousSong() {
    if (!currentRoom || !Array.isArray(currentRoom.queue) || currentRoom.queue.length === 0) {
        showToast('No songs in queue', 'info');
        return;
    }
    const currentSong = currentRoom.queue[currentSongIndex];
    const isVideoSong = isYouTubeMedia(currentSong);
    let ct = 0;
    if (isVideoSong && ytPlayer) {
        try { ct = ytPlayer.getCurrentTime() || 0; } catch (e) { }
    } else {
        ct = audioPlayer.currentTime || currentTime;
    }
    if (ct > 3) {
        currentTime = 0;
        if (isVideoSong && ytPlayer) {
            try { suppressYtStateSync(900); ytPlayer.seekTo(0, true); } catch (e) { }
        } else {
            try { audioPlayer.currentTime = 0; } catch (e) { }
        }
        updateProgress();
        sendPlaybackCommand('seek', 0);
    } else {
        var prevIdx = currentSongIndex - 1;
        if (prevIdx < 0) {
            showToast('Already at first song', 'info');
            return;
        }
        currentSongIndex = prevIdx;
        localTransitionTargetIndex = prevIdx;
        localTransitionTimestamp = Date.now();
        var song = currentRoom.queue[prevIdx];
        isPlaying = true;
        updatePlayPauseIcon();
        nextSongSent = false; // Reset for new song
        updateNowPlaying(song, { playing: true, currentSongIndex: prevIdx, currentTime: 0 });
        startProgressTimer();
        document.getElementById('sound-waves').classList.add('active');
        _lastUserMove = Date.now();
        sendPlaybackCommand('previous', 0);
    }
}

function playSongAtIndex(index) {
    if (!currentRoom || !Array.isArray(currentRoom.queue) || index < 0 || index >= currentRoom.queue.length) {
        showToast('Unable to select that song right now. Try again.', 'error');
        return;
    }

    unlockAudio().catch(() => { });

    const selectedSong = currentRoom && Array.isArray(currentRoom.queue)
        ? currentRoom.queue[index]
        : null;
    const isSelectedVideo = isYouTubeMedia(selectedSong);

    if (isSelectedVideo) {
        stopAudioPlayback(true);
    }

    currentSongIndex = index;
    localTransitionTargetIndex = index;
    localTransitionTimestamp = Date.now();
    nextSongSent = false; // Reset for new song
    sendPlaybackCommand('select', index);
}

function seekTo(event) {
    const bar = document.getElementById('progress-bar');
    const rect = bar.getBoundingClientRect();
    const pointerX = typeof event.clientX === 'number'
        ? event.clientX
        : (event.touches && event.touches[0] ? event.touches[0].clientX : null);
    if (pointerX === null) return;

    const pos = Math.max(0, Math.min(1, (pointerX - rect.left) / rect.width));

    const currentSong = currentRoom && currentRoom.queue ? currentRoom.queue[currentSongIndex] : null;
    const isVideoSong = isYouTubeMedia(currentSong);
    let totalDuration;
    if (isVideoSong && ytPlayer) {
        try { totalDuration = ytPlayer.getDuration() || duration; } catch (e) { totalDuration = duration; }
    } else {
        totalDuration = audioPlayer.duration || duration;
    }
    if (!totalDuration || totalDuration <= 0) return;

    const seekTime = pos * totalDuration;

    currentTime = seekTime;
    if (isVideoSong && ytPlayer) {
        try {
            suppressYtStateSync(900);
            ytPlayer.seekTo(seekTime, true);
        } catch (e) { }
    } else {
        try {
            audioPlayer.currentTime = seekTime;
        } catch (err) {
            console.warn('[Playback] Failed to apply local seek:', err);
        }
    }
    updateProgress();

    sendPlaybackCommand('seek', seekTime);
}

function sendPlaybackCommand(action, time) {
    const payload = {
        roomCode: currentRoom.roomCode,
        action: action,
        currentTime: time
    };
    if (socket && socket.connected) {
        socket.emit('room:playback', payload);
    } else {
        fetch('/api/rooms/' + encodeURIComponent(currentRoom.roomCode) + '/playback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(res => res.json()).then(data => {
            if (data.roomState) updateRoomUI(data.roomState);
        }).catch(err => console.warn('Playback HTTP fallback error:', err));
    }
}

function startProgressTimer() {
    stopProgressTimer();
    nextSongSent = false; // Reset shared flag when starting new song
    progressInterval = setInterval(() => {
        if (!isPlaying) return;

        const currentSong = currentRoom && currentRoom.queue ? currentRoom.queue[currentSongIndex] : null;
        const isVideoSong = isYouTubeMedia(currentSong);

        // Don't auto-advance if user just manually clicked next/previous
        if (Date.now() - _lastUserMove < 5000) return;

        if (!isVideoSong) {
            const audDur = audioPlayer.duration, audCur = audioPlayer.currentTime;
            if (audDur > 0 && audCur >= audDur - 0.5 && !nextSongSent) {
                nextSongSent = true;
                sendPlaybackCommand('next', 0);
                return;
            }
        } else if (isVideoSong && !nextSongSent && ytPlayer) {
            try {
                const ytDur = ytPlayer.getDuration();
                const ytCur = ytPlayer.getCurrentTime();
                if (ytDur > 0 && ytCur >= ytDur - 1) {
                    nextSongSent = true;
                    sendPlaybackCommand('next', 0);
                    return;
                }
            } catch (e) { }
        }

        updateProgress();
    }, 500);
}

function stopProgressTimer() {
    if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
    }
}
function updateProgress() {
    const fill = document.getElementById('progress-fill');
    const thumb = document.getElementById('progress-thumb');
    const timeCurrent = document.getElementById('time-current');
    const timeTotal = document.getElementById('time-total');

    const currentSong = currentRoom && currentRoom.queue ? currentRoom.queue[currentSongIndex] : null;
    const isVideoSong = isYouTubeMedia(currentSong);
    let audioTime, audioDur;
    if (isVideoSong && ytPlayer) {
        try {
            audioTime = ytPlayer.getCurrentTime() || currentTime;
            audioDur = ytPlayer.getDuration() || duration;
        } catch (e) {
            audioTime = currentTime;
            audioDur = duration;
        }
    } else {
        audioDur = audioPlayer.duration || duration;
        audioTime = audioPlayer.currentTime || currentTime;
    }
    const pct = audioDur > 0 ? (audioTime / audioDur) * 100 : 0;
    fill.style.width = pct + '%';
    timeCurrent.textContent = formatTime(Math.floor(audioTime));
    if (timeTotal && audioDur > 0) {
        timeTotal.textContent = formatTime(Math.floor(audioDur));
    }
}

function updatePlayPauseIcon() {
    const icon = document.getElementById('play-pause-icon');
    icon.className = isPlaying ? 'fas fa-pause' : 'fas fa-play';
}

// ===== WebSocket (Socket.io) =====
function connectWebSocket(roomCode, username) {
    if (socket && socket.connected) {
        console.log('[WebSocket] Already connected');
        return;
    }

    if (connectionRetries >= maxRetries) {
        console.error('[WebSocket] Max retries reached. Please refresh the page.');
        showToast('Connection failed. Please refresh the page.', 'error');
        return;
    }

    isConnecting = true;
    connectionRetries++;

    const statusEl = document.getElementById('connection-status');
    statusEl.className = 'connection-status show';
    statusEl.innerHTML = '<i class="fas fa-wifi"></i><span>Connecting' + (connectionRetries > 1 ? ' (attempt ' + connectionRetries + ')' : '') + '...</span>';

    try {
        if (typeof io === 'undefined') {
            console.warn('[WebSocket] Socket.IO client library (io) not found. Running in HTTP Sync Mode.');
            isConnecting = false;
            statusEl.className = 'connection-status show connected';
            statusEl.innerHTML = '<i class="fas fa-check-circle"></i><span>HTTP Sync Mode</span>';
            setTimeout(() => statusEl.classList.remove('show'), 2000);
            return;
        }

        if (!socket) {
            const socketOpts = {
                reconnection: true,
                reconnectionAttempts: 5,
                reconnectionDelay: 1500
            };
            const customBackend = window.BACKEND_URL || localStorage.getItem('musicsync_backend_url') || '';
            socket = customBackend ? io(customBackend, socketOpts) : io(socketOpts);

            socket.on('connect', () => {
                console.log('[WebSocket] Connected successfully via Socket.io!', socket.id);
                isConnecting = false;
                connectionRetries = 0;
                statusEl.className = 'connection-status show connected';
                statusEl.innerHTML = '<i class="fas fa-wifi"></i><span>Connected</span>';
                setTimeout(() => statusEl.classList.remove('show'), 2000);

                if (currentRoom && currentRoom.roomCode) {
                    socket.emit('room:register', {
                        roomCode: currentRoom.roomCode,
                        username: currentUser
                    });
                    socket.emit('room:sync', {
                        roomCode: currentRoom.roomCode
                    });
                }
                executePendingActions();
            });

            socket.on('room:state', (state) => {
                updateRoomUI(state);
            });

            socket.on('room:playback', (data) => {
                handlePlaybackUpdate(data);
            });

            socket.on('room:chat', (chatMsg) => {
                appendChatMessage(chatMsg);
            });

            socket.on('room:sync', (state) => {
                updateRoomUI(state);
            });

            socket.on('disconnect', (reason) => {
                console.warn('[WebSocket] Socket disconnected:', reason);
                isConnecting = false;
                statusEl.className = 'connection-status show connected';
                statusEl.innerHTML = '<i class="fas fa-check-circle"></i><span>HTTP Sync Mode</span>';
            });

            socket.on('connect_error', (error) => {
                console.warn('[WebSocket] Realtime socket inactive (using HTTP sync mode):', error.message || error);
                isConnecting = false;
                statusEl.className = 'connection-status show connected';
                statusEl.innerHTML = '<i class="fas fa-check-circle"></i><span>HTTP Sync Mode</span>';
                setTimeout(() => statusEl.classList.remove('show'), 2000);
            });
        } else if (!socket.connected) {
            socket.connect();
        }
    } catch (err) {
        console.warn('[WebSocket] Exception during connection, falling back to HTTP sync:', err);
        isConnecting = false;
        statusEl.className = 'connection-status show connected';
        statusEl.innerHTML = '<i class="fas fa-check-circle"></i><span>HTTP Sync Mode</span>';
        setTimeout(() => statusEl.classList.remove('show'), 2000);
    }
}

function handlePlaybackUpdate(data) {
    if (!data) return;
    const isSyncTick = data.syncTick === true;
    const ps = (data.playbackState && typeof data.playbackState === 'object')
        ? data.playbackState
        : data;

    console.log('[handlePlaybackUpdate] Received:', { isSyncTick, currentSongIndex, incomingIdx: ps?.currentSongIndex, playing: ps?.playing });

    if (isSyncTick) {
        // Sync tick: never change song index, audio source, now-playing display, OR playing state.
        // Only sync current time to keep progress bars aligned.
        // The playing state is set by local user actions (togglePlayPause) or
        // authoritative command responses (non-sync-tick broadcasts). Overwriting
        // it here creates a race where a sync tick arrives before the server
        // processes the user's pause command, causing the video to auto-resume.
        if (ps) {
            const activeSong = currentRoom && Array.isArray(currentRoom.queue)
                ? currentRoom.queue[currentSongIndex]
                : null;
            const isVideoNow = isYouTubeMedia(activeSong);

            if (isVideoNow) {
                const serverTime = Number(ps.currentTime);
                if (Number.isFinite(serverTime) && serverTime >= 0) {
                    currentTime = serverTime;
                    try {
                        if (ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
                            const localVideoTime = ytPlayer.getCurrentTime() || 0;
                            if (shouldResyncYtTime(localVideoTime, serverTime)) {
                                suppressYtStateSync(1100);
                                ytPlayer.seekTo(serverTime, true);
                            }
                        }
                    } catch (err) {
                        console.warn('[Playback] Failed to apply synced video time:', err);
                    }
                }

                if (isPlaying) {
                    try {
                        const playerState = (ytPlayer && typeof ytPlayer.getPlayerState === 'function')
                            ? ytPlayer.getPlayerState()
                            : null;
                        if (
                            ytPlayer
                            && typeof ytPlayer.playVideo === 'function'
                            && playerState !== YT.PlayerState.PLAYING
                            && playerState !== YT.PlayerState.BUFFERING
                        ) {
                            suppressYtStateSync(900);
                            ytPlayer.playVideo();
                        }
                    } catch (err) {
                        console.warn('[Playback] Failed to play video:', err);
                    }
                    startProgressTimer();
                    document.getElementById('sound-waves').classList.add('active');
                } else {
                    try {
                        const playerState = (ytPlayer && typeof ytPlayer.getPlayerState === 'function')
                            ? ytPlayer.getPlayerState()
                            : null;
                        if (
                            ytPlayer
                            && typeof ytPlayer.pauseVideo === 'function'
                            && (playerState === YT.PlayerState.PLAYING || playerState === YT.PlayerState.BUFFERING)
                        ) {
                            suppressYtStateSync(900);
                            ytPlayer.pauseVideo();
                        }
                    } catch (err) {
                        console.warn('[Playback] Failed to pause video:', err);
                    }
                    stopProgressTimer();
                    document.getElementById('sound-waves').classList.remove('active');
                }
            } else if (activeSong && activeSong.audioUrl) {
                const serverTime = Number(ps.currentTime);
                if (Number.isFinite(serverTime) && serverTime >= 0) {
                    const knownDuration = (Number.isFinite(audioPlayer.duration) && audioPlayer.duration > 0)
                        ? audioPlayer.duration
                        : duration;
                    const clampedTime = knownDuration > 0 ? Math.min(serverTime, knownDuration) : serverTime;

                    currentTime = clampedTime;
                    if (Math.abs((audioPlayer.currentTime || 0) - clampedTime) > 0.7) {
                        try {
                            audioPlayer.currentTime = clampedTime;
                        } catch (err) {
                            console.warn('[Playback] Failed to apply synced time:', err);
                        }
                    }
                }

                if (isPlaying && audioPlayer.paused) {
                    audioPlayer.play().catch(() => {
                        requestUserAudioResume();
                    });
                    startProgressTimer();
                    document.getElementById('sound-waves').classList.add('active');
                } else if (!isPlaying && !audioPlayer.paused) {
                    audioPlayer.pause();
                    stopProgressTimer();
                    document.getElementById('sound-waves').classList.remove('active');
                }
            }

            updateProgress();
        }

        if (currentRoom && currentRoom.queue) {
            updateQueue(currentRoom.queue, { currentSongIndex: currentSongIndex });
        }
        return;
    }

    console.log('[handlePlaybackUpdate] Non-sync-tick path:', { currentSongIndex_before: currentSongIndex, incomingIdx: ps?.currentSongIndex });

    const incomingIdx = ps ? ps.currentSongIndex : -1;

    // Check bidirectional transition lock
    if (localTransitionTargetIndex !== null && (Date.now() - localTransitionTimestamp) < LOCAL_TRANSITION_LOCK_MS) {
        if (incomingIdx !== localTransitionTargetIndex) {
            console.log('[handlePlaybackUpdate] Transition lock active, ignoring incomingIdx:', incomingIdx, 'expecting:', localTransitionTargetIndex);
            if (currentRoom && currentRoom.queue) {
                updateQueue(currentRoom.queue, { currentSongIndex: currentSongIndex });
            }
            return;
        } else {
            localTransitionTargetIndex = null;
        }
    }

    // If the index matches the optimistic value, skip the heavy updateNowPlaying call
    // (avoids interfering with the audio transition) but still apply time/playing state.
    const userJustMoved = (Date.now() - _lastUserMove < 1500);
    if (userJustMoved && incomingIdx >= 0 && incomingIdx === currentSongIndex) {
        console.log('[handlePlaybackUpdate] Index matches local, applying server time/state');
        if (ps) {
            currentTime = ps.currentTime || 0;
            isPlaying = ps.playing;
            updatePlayPauseIcon();
            updateProgress();
        }
        if (currentRoom && currentRoom.queue) {
            updateQueue(currentRoom.queue, { currentSongIndex: currentSongIndex });
        }
        return;
    }

    const incomingSong = data.currentSong && data.currentSong.title ? data.currentSong : null;
    const fallbackSong = (ps && currentRoom && Array.isArray(currentRoom.queue)
        && incomingIdx >= 0 && incomingIdx < currentRoom.queue.length)
        ? currentRoom.queue[incomingIdx]
        : null;
    const song = incomingSong || fallbackSong;

    // Reset nextSongSent when song actually changes (forward progress)
    if (song && song.title && incomingIdx !== currentSongIndex) {
        nextSongSent = false;
    }

    if (song && song.title) {
        updateNowPlaying(song, ps);
    } else if (currentRoom && Array.isArray(currentRoom.queue) && currentRoom.queue.length === 0) {
        updateNowPlaying(null, ps);
    }

    if (ps) {
        currentSongIndex = incomingIdx;
        isPlaying = ps.playing;
        updatePlayPauseIcon();

        const isVideoSong = isYouTubeMedia(song);

        if (isVideoSong) {
            stopAudioPlayback(false);
            const serverTime = Number(ps.currentTime);
            if (Number.isFinite(serverTime) && serverTime >= 0) {
                currentTime = serverTime;
                try {
                    if (ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
                        const localVideoTime = ytPlayer.getCurrentTime() || 0;
                        if (shouldResyncYtTime(localVideoTime, serverTime)) {
                            suppressYtStateSync(1100);
                            ytPlayer.seekTo(serverTime, true);
                        }
                    }
                } catch (err) {
                    console.warn('[Playback] Failed to apply synced video time:', err);
                }
            }

            if (isPlaying) {
                try {
                    const playerState = (ytPlayer && typeof ytPlayer.getPlayerState === 'function')
                        ? ytPlayer.getPlayerState()
                        : null;
                    if (
                        ytPlayer
                        && typeof ytPlayer.playVideo === 'function'
                        && playerState !== YT.PlayerState.PLAYING
                        && playerState !== YT.PlayerState.BUFFERING
                    ) {
                        suppressYtStateSync(900);
                        ytPlayer.playVideo();
                    }
                } catch (err) {
                    console.warn('[Playback] Failed to play video:', err);
                }
                startProgressTimer();
                document.getElementById('sound-waves').classList.add('active');
            } else {
                try {
                    const playerState = (ytPlayer && typeof ytPlayer.getPlayerState === 'function')
                        ? ytPlayer.getPlayerState()
                        : null;
                    if (
                        ytPlayer
                        && typeof ytPlayer.pauseVideo === 'function'
                        && (playerState === YT.PlayerState.PLAYING || playerState === YT.PlayerState.BUFFERING)
                    ) {
                        suppressYtStateSync(900);
                        ytPlayer.pauseVideo();
                    }
                } catch (err) {
                    console.warn('[Playback] Failed to pause video:', err);
                }
                stopProgressTimer();
                document.getElementById('sound-waves').classList.remove('active');
            }
        } else if (song && song.audioUrl) {
            const serverTime = Number(ps.currentTime);
            if (Number.isFinite(serverTime) && serverTime >= 0) {
                const knownDuration = (Number.isFinite(audioPlayer.duration) && audioPlayer.duration > 0)
                    ? audioPlayer.duration
                    : duration;
                const clampedTime = knownDuration > 0 ? Math.min(serverTime, knownDuration) : serverTime;

                currentTime = clampedTime;
                if (Math.abs((audioPlayer.currentTime || 0) - clampedTime) > 0.7) {
                    try {
                        audioPlayer.currentTime = clampedTime;
                    } catch (err) {
                        console.warn('[Playback] Failed to apply synced time:', err);
                    }
                }
            }

            if (isPlaying && audioPlayer.paused) {
                audioPlayer.play().catch(() => {
                    requestUserAudioResume();
                });
                startProgressTimer();
                document.getElementById('sound-waves').classList.add('active');
            } else if (!isPlaying && !audioPlayer.paused) {
                audioPlayer.pause();
                stopProgressTimer();
                document.getElementById('sound-waves').classList.remove('active');
            }
        }

        updateProgress();
    }

    if (currentRoom && currentRoom.queue) {
        updateQueue(currentRoom.queue, { currentSongIndex: currentSongIndex });
    }
}

// ===== Chat =====
function sendChat() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    if (!message || !currentRoom) return;

    if (socket && socket.connected) {
        socket.emit('room:chat', {
            roomCode: currentRoom.roomCode,
            username: currentUser,
            message: message
        });
        input.value = '';
        return;
    }

    // Direct HTTP REST fallback
    fetch('/api/rooms/' + encodeURIComponent(currentRoom.roomCode) + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: currentUser, message: message })
    }).then(res => res.json()).then(data => {
        if (data.chatMsg) appendChatMessage(data.chatMsg);
        input.value = '';
    }).catch(err => {
        console.warn('Chat HTTP fallback error:', err);
    });
}

function handleChatKeypress(e) {
    if (e.key === 'Enter') {
        sendChat();
    }
}

function appendChatMessage(msg) {
    const container = document.getElementById('chat-messages');

    if (msg.type === 'system') {
        const text = typeof msg.message === 'string' ? msg.message.trim() : '';

        container.innerHTML += `
            <div class="chat-msg system">
                <div class="chat-msg-content">
                    <div class="chat-msg-text">${escapeHtml(msg.message)}</div>
                </div>
            </div>
        `;

        if (/joined the room/i.test(text) || /left the room/i.test(text)) {
            scheduleRoomStateRefresh(120);
        }
    } else {
        const initial = msg.username ? msg.username.charAt(0).toUpperCase() : '?';
        const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        container.innerHTML += `
            <div class="chat-msg">
                <div class="chat-msg-avatar" style="background: ${escapeAttr(msg.avatarColor || '#1DB954')}">${escapeHtml(initial)}</div>
                <div class="chat-msg-content">
                    <div class="chat-msg-header">
                        <span class="chat-msg-name">${escapeHtml(msg.username)}</span>
                        <span class="chat-msg-time">${escapeHtml(time)}</span>
                    </div>
                    <div class="chat-msg-text">${escapeHtml(msg.message)}</div>
                </div>
            </div>
        `;
    }

    container.scrollTop = container.scrollHeight;
}

// ===== UI Helpers =====
const tabHistory = [];

function switchTab(tabName, pushHistory = true) {
    const current = document.querySelector('.tab-btn.active');
    const currentTab = current ? current.id.replace('tab-', '') : null;
    if (pushHistory && currentTab && currentTab !== tabName) {
        if (tabHistory[tabHistory.length - 1] !== currentTab) {
            tabHistory.push(currentTab);
        }
    }
    document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(p => p.classList.remove('active'));
    const tabEl = document.getElementById('tab-' + tabName);
    const panelEl = document.getElementById(tabName + '-panel');
    if (tabEl) tabEl.classList.add('active');
    if (panelEl) panelEl.classList.add('active');
    if (tabName === 'playlists') {
        renderCustomPlaylistsUI();
    }
    _updateSearchBackBtn();
}

function _updateSearchBackBtn() {
    const btn = document.getElementById('search-back-btn');
    if (!btn) return;
    const onSearchTab = !!document.querySelector('#tab-search.active');
    if (onSearchTab && (tabHistory.length > 0 || searchViewHistory.length > 0 || _allSearchResults.length > 0)) {
        btn.classList.remove('hidden');
    } else {
        btn.classList.add('hidden');
    }
}

function goBackInSearch() {
    if (searchViewHistory.length > 0) {
        restoreSearchView(searchViewHistory.pop());
        return;
    }

    if (_allSearchResults.length > 0) {
        const input = document.getElementById('external-search');
        const resultsList = document.getElementById('search-results');
        const emptyEl = document.getElementById('search-empty');
        _allSearchResults = [];
        currentSearchResultTab = 'songs';
        if (resultsList) resultsList.innerHTML = '';
        if (emptyEl) emptyEl.classList.remove('hidden');
        updateSourceFilterButtons(false, false, false);
        if (input) input.focus();
    } else {
        const prev = tabHistory.length > 0 ? tabHistory.pop() : 'queue';
        switchTab(prev, false);
    }
    _updateSearchBackBtn();
}

function copyRoomCode() {
    const code = currentRoom?.roomCode;
    if (!code) return;

    navigator.clipboard.writeText(code).then(() => {
        const tooltip = document.querySelector('.copy-tooltip');
        tooltip.classList.add('show');
        setTimeout(() => tooltip.classList.remove('show'), 1500);
    }).catch(() => {
        showToast('Room code: ' + code, 'info');
    });
}

function leaveRoom() {
    if (socket) {
        socket.disconnect();
        socket = null;
    }
    stopRoomStatePolling();
    stopAudioPlayback(true);
    currentRoom = null;
    currentUser = null;
    currentUserId = null;
    currentUsers = [];
    if (friendsRefreshInterval) {
        clearInterval(friendsRefreshInterval);
        friendsRefreshInterval = null;
    }
    isHost = false;
    isPlaying = false;
    stopProgressTimer();
    closeListenersModal();

    tabHistory.length = 0;
    currentSearchResultTab = 'songs';
    searchViewHistory.length = 0;
    // Clear navigation history so back always returns to home after leaving a room
    screenHistory.length = 0;
    showScreen('home-screen', false);
    history.replaceState({ screenId: 'home-screen' }, '', '#home-screen');
    fetchStats();
    showToast('Left the room', 'info');
}

function showFormError(elementId, message) {
    const el = document.getElementById(elementId);
    el.textContent = message;
    el.classList.remove('hidden');
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle' };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i><span class="toast-message">${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
}

function formatTime(seconds) {
    if (!seconds || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function escapeAttr(text) {
    if (!text) return '';
    return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================================
// ===== IN-BUILT CUSTOM PLAYLISTS ENGINE =====================================
// ============================================================================

const PLAYLISTS_STORAGE_KEY = 'musicsync_custom_playlists';

function getCustomPlaylists() {
    try {
        const stored = localStorage.getItem(PLAYLISTS_STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) {
                // Remove legacy default starter if present
                const clean = parsed.filter(p => p && p.id !== 'my_tamil_vibe_starter');
                if (clean.length !== parsed.length) {
                    try { localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(clean)); } catch (e) { }
                }
                return clean;
            }
        }
    } catch (e) {
        console.warn('Error reading custom playlists from localStorage:', e);
    }
    return [];
}

function saveCustomPlaylists(playlists) {
    try {
        localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(playlists));
        updatePlaylistBadges();
    } catch (e) {
        console.error('Error saving custom playlists to localStorage:', e);
    }
}

function updatePlaylistBadges() {
    const list = getCustomPlaylists();
    const count = list.length;
    const badge = document.getElementById('playlists-count');
    if (badge) badge.textContent = count;
}

function renderCustomPlaylistsUI() {
    updatePlaylistBadges();
    const grid = document.getElementById('custom-playlists-grid');
    const empty = document.getElementById('custom-playlists-empty');
    if (!grid) return;

    const playlists = getCustomPlaylists();
    if (!playlists || playlists.length === 0) {
        grid.innerHTML = '';
        if (empty) empty.classList.remove('hidden');
        return;
    }

    if (empty) empty.classList.add('hidden');

    grid.innerHTML = playlists.map(p => {
        const songCount = Array.isArray(p.songs) ? p.songs.length : 0;
        const firstSong = songCount > 0 ? p.songs[0] : null;
        const coverSrc = p.coverUrl || (firstSong && firstSong.coverUrl) || '';

        const coverHtml = coverSrc
            ? `<img class="custom-pl-cover-img" src="${escapeAttr(coverSrc)}" alt="${escapeAttr(p.title)}" onerror="this.src='/images/default-cover.png'">`
            : `<div class="custom-pl-cover-placeholder"><i class="fas fa-music"></i></div>`;

        return `
            <div class="custom-pl-card" onclick="openManagePlaylistModal('${escapeAttr(p.id)}')">
                <div class="custom-pl-cover-wrapper">
                    ${coverHtml}
                    <div class="custom-pl-tag"><i class="fas fa-list"></i> ${songCount} ${songCount === 1 ? 'song' : 'songs'}</div>
                </div>
                <div class="custom-pl-info">
                    <h4>${escapeHtml(p.title)}</h4>
                    <p>${escapeHtml(p.description || (songCount + ' tracks in playlist'))}</p>
                </div>
                <div class="custom-pl-actions" onclick="event.stopPropagation()">
                    <button class="btn btn-primary" onclick="playCustomPlaylist('${escapeAttr(p.id)}', true)" title="Start playing in room">
                        <i class="fas fa-play"></i> Play
                    </button>
                    <button class="btn btn-secondary" onclick="playCustomPlaylist('${escapeAttr(p.id)}', false)" title="Add all to queue">
                        <i class="fas fa-plus"></i> Queue
                    </button>
                    <button class="custom-pl-btn-icon" onclick="openManagePlaylistModal('${escapeAttr(p.id)}')" title="Customize playlist">
                        <i class="fas fa-sliders-h"></i>
                    </button>
                    <button class="custom-pl-btn-icon danger" onclick="deleteCustomPlaylist('${escapeAttr(p.id)}')" title="Delete playlist">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function playCustomPlaylist(playlistId, playImmediately = true) {
    if (!currentRoom) {
        showToast('Join or create a room first', 'error');
        return;
    }
    const playlists = getCustomPlaylists();
    const playlist = playlists.find(p => p.id === playlistId);
    if (!playlist) {
        showToast('Playlist not found', 'error');
        return;
    }
    if (!Array.isArray(playlist.songs) || playlist.songs.length === 0) {
        showToast('Playlist is empty. Add songs first!', 'error');
        return;
    }

    // Cache songs in songMetadataStore
    playlist.songs.forEach(s => {
        if (s && s.id) songMetadataStore.set(s.id, s);
    });

    unlockAudio().catch(() => {});

    if (!socket || !socket.connected) {
        showToast('Reconnecting...', 'info');
        waitForConnection(() => {
            _emitAddBatch(playlist.songs, playlist.title, playImmediately);
        });
        return;
    }

    _emitAddBatch(playlist.songs, playlist.title, playImmediately);
}

function saveQueueAsPlaylist() {
    if (!currentRoom || !Array.isArray(currentRoom.queue) || currentRoom.queue.length === 0) {
        showToast('Room queue is currently empty', 'error');
        return;
    }

    const defaultTitle = (currentRoom.roomName ? currentRoom.roomName + ' Mix' : 'Room Queue') + ' - ' + new Date().toLocaleDateString([], { month: 'short', day: 'numeric' });
    const title = prompt('Enter a name for this new playlist:', defaultTitle);
    if (!title || !title.trim()) return;

    const playlists = getCustomPlaylists();
    const newPlaylist = {
        id: 'pl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        title: title.trim(),
        description: `Saved from room ${currentRoom.roomCode} with ${currentRoom.queue.length} tracks`,
        coverUrl: currentRoom.queue[0]?.coverUrl || '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        songs: JSON.parse(JSON.stringify(currentRoom.queue))
    };

    playlists.unshift(newPlaylist);
    saveCustomPlaylists(playlists);
    showToast(`Saved ${newPlaylist.songs.length} songs into "${newPlaylist.title}"!`, 'success');
}

let songPendingPlaylistAddition = null;

function addCurrentSongToPlaylist() {
    if (!currentRoom || !Array.isArray(currentRoom.queue) || currentSongIndex < 0 || !currentRoom.queue[currentSongIndex]) {
        showToast('No song currently playing', 'error');
        return;
    }
    openAddToPlaylistModal(currentRoom.queue[currentSongIndex]);
}

function openAddToPlaylistModal(songOrSongId) {
    let song = null;
    if (typeof songOrSongId === 'string') {
        song = songMetadataStore.get(songOrSongId)
            || (Array.isArray(_allSearchResults) ? _allSearchResults.find(s => s && s.id === songOrSongId) : null)
            || (currentRoom && Array.isArray(currentRoom.queue) ? currentRoom.queue.find(s => s && s.id === songOrSongId) : null);
    } else if (songOrSongId && typeof songOrSongId === 'object') {
        song = songOrSongId;
    } else if (currentRoom && Array.isArray(currentRoom.queue) && currentRoom.queue[currentSongIndex]) {
        song = currentRoom.queue[currentSongIndex];
    }

    if (!song) {
        showToast('No song found to add', 'error');
        return;
    }

    songPendingPlaylistAddition = song;

    const modal = document.getElementById('add-to-playlist-modal');
    const thumbEl = document.getElementById('modal-song-thumb');
    const titleEl = document.getElementById('modal-song-title');
    const artistEl = document.getElementById('modal-song-artist');
    const inputEl = document.getElementById('quick-playlist-name');
    const listEl = document.getElementById('existing-playlists-list');

    if (thumbEl) thumbEl.src = song.coverUrl || '/images/default-cover.png';
    if (titleEl) titleEl.textContent = song.title || 'Unknown Title';
    if (artistEl) artistEl.textContent = song.artist || 'Unknown Artist';
    if (inputEl) inputEl.value = '';

    // Render existing playlists
    const playlists = getCustomPlaylists();
    if (listEl) {
        if (playlists.length === 0) {
            listEl.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.85rem; padding: 10px 0;">No playlists yet. Enter a name above to create your first one!</div>';
        } else {
            listEl.innerHTML = playlists.map(p => {
                const count = Array.isArray(p.songs) ? p.songs.length : 0;
                const alreadyContains = Array.isArray(p.songs) && p.songs.some(s => s && s.id === song.id);
                return `
                    <div class="existing-playlist-item" onclick="addSongToExistingPlaylist('${escapeAttr(p.id)}')">
                        <div>
                            <div class="existing-pl-title">${escapeHtml(p.title)}</div>
                            <div class="existing-pl-count">${count} song${count === 1 ? '' : 's'}</div>
                        </div>
                        <div>
                            ${alreadyContains ? '<span style="color: var(--accent); font-size: 0.75rem;"><i class="fas fa-check"></i> Already in</span>' : '<i class="fas fa-plus" style="color: #888;"></i>'}
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    if (modal) modal.classList.remove('hidden');
}

function closeAddToPlaylistModal() {
    const modal = document.getElementById('add-to-playlist-modal');
    if (modal) modal.classList.add('hidden');
    songPendingPlaylistAddition = null;
}

function handleAddToPlaylistBackdrop(event) {
    if (event.target && event.target.id === 'add-to-playlist-modal') {
        closeAddToPlaylistModal();
    }
}

function addSongToExistingPlaylist(playlistId) {
    if (!songPendingPlaylistAddition) return;
    const playlists = getCustomPlaylists();
    const playlist = playlists.find(p => p.id === playlistId);
    if (!playlist) {
        showToast('Playlist not found', 'error');
        return;
    }

    if (!Array.isArray(playlist.songs)) playlist.songs = [];

    // Check if song already exists in this playlist
    const alreadyExists = playlist.songs.some(s => s && s.id === songPendingPlaylistAddition.id);
    if (alreadyExists) {
        showToast(`"${songPendingPlaylistAddition.title}" is already in "${playlist.title}"`, 'info');
        closeAddToPlaylistModal();
        return;
    }

    playlist.songs.push({
        id: songPendingPlaylistAddition.id,
        title: songPendingPlaylistAddition.title || 'Unknown Title',
        artist: songPendingPlaylistAddition.artist || 'Unknown Artist',
        album: songPendingPlaylistAddition.album || '',
        coverUrl: songPendingPlaylistAddition.coverUrl || '',
        durationSeconds: songPendingPlaylistAddition.durationSeconds || 0,
        audioUrl: songPendingPlaylistAddition.audioUrl || ''
    });

    playlist.updatedAt = Date.now();
    saveCustomPlaylists(playlists);
    showToast(`Added to "${playlist.title}"!`, 'success');
    closeAddToPlaylistModal();
    renderCustomPlaylistsUI();
}

function createPlaylistAndAddSong() {
    const input = document.getElementById('quick-playlist-name');
    const title = input ? input.value.trim() : '';
    if (!title) {
        showToast('Please enter a playlist name', 'error');
        return;
    }
    if (!songPendingPlaylistAddition) {
        showToast('No song selected', 'error');
        return;
    }

    const playlists = getCustomPlaylists();
    const newPlaylist = {
        id: 'pl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        title: title,
        description: 'Created by you',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        songs: [{
            id: songPendingPlaylistAddition.id,
            title: songPendingPlaylistAddition.title || 'Unknown Title',
            artist: songPendingPlaylistAddition.artist || 'Unknown Artist',
            album: songPendingPlaylistAddition.album || '',
            coverUrl: songPendingPlaylistAddition.coverUrl || '',
            durationSeconds: songPendingPlaylistAddition.durationSeconds || 0,
            audioUrl: songPendingPlaylistAddition.audioUrl || ''
        }]
    };

    playlists.unshift(newPlaylist);
    saveCustomPlaylists(playlists);
    showToast(`Created "${newPlaylist.title}" and added song!`, 'success');
    closeAddToPlaylistModal();
    renderCustomPlaylistsUI();
}

function openCreatePlaylistModal() {
    const modal = document.getElementById('create-playlist-modal');
    const titleInput = document.getElementById('new-playlist-title');
    const descInput = document.getElementById('new-playlist-desc');
    if (titleInput) titleInput.value = '';
    if (descInput) descInput.value = '';
    if (modal) modal.classList.remove('hidden');
    if (titleInput) titleInput.focus();
}

function closeCreatePlaylistModal() {
    const modal = document.getElementById('create-playlist-modal');
    if (modal) modal.classList.add('hidden');
}

function handleCreatePlaylistBackdrop(event) {
    if (event.target && event.target.id === 'create-playlist-modal') {
        closeCreatePlaylistModal();
    }
}

function confirmCreatePlaylist() {
    const titleInput = document.getElementById('new-playlist-title');
    const descInput = document.getElementById('new-playlist-desc');
    const title = titleInput ? titleInput.value.trim() : '';
    const desc = descInput ? descInput.value.trim() : '';

    if (!title) {
        showToast('Please enter a playlist title', 'error');
        return;
    }

    const playlists = getCustomPlaylists();
    const newPlaylist = {
        id: 'pl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        title: title,
        description: desc || 'Custom playlist created by you',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        songs: []
    };

    playlists.unshift(newPlaylist);
    saveCustomPlaylists(playlists);
    showToast(`Created playlist "${newPlaylist.title}"!`, 'success');
    closeCreatePlaylistModal();
    renderCustomPlaylistsUI();
}

let currentManagedPlaylistId = null;

function openManagePlaylistModal(playlistId) {
    const playlists = getCustomPlaylists();
    const playlist = playlists.find(p => p.id === playlistId);
    if (!playlist) {
        showToast('Playlist not found', 'error');
        return;
    }

    currentManagedPlaylistId = playlistId;

    const modal = document.getElementById('manage-playlist-modal');
    const titleEl = document.getElementById('manage-playlist-title');
    const descEl = document.getElementById('manage-playlist-desc');
    const countEl = document.getElementById('manage-tracklist-count');
    const listEl = document.getElementById('manage-tracks-list');

    const songCount = Array.isArray(playlist.songs) ? playlist.songs.length : 0;

    if (titleEl) titleEl.textContent = playlist.title;
    if (descEl) descEl.textContent = `${songCount} song${songCount === 1 ? '' : 's'} • ${playlist.description || 'Custom playlist'}`;
    if (countEl) countEl.textContent = songCount;

    if (listEl) {
        if (songCount === 0) {
            listEl.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 32px 0;"><i class="fas fa-music" style="font-size: 2rem; margin-bottom: 8px;"></i><p>No songs in this playlist yet.</p><p style="font-size: 0.8rem;">Search songs or browse queue and click <i class="fas fa-folder-plus"></i> to add!</p></div>';
        } else {
            listEl.innerHTML = playlist.songs.map((s, idx) => `
                <div class="manage-track-row">
                    <span style="color: var(--text-secondary); font-size: 0.85rem; width: 22px;">${idx + 1}</span>
                    <img src="${escapeAttr(s.coverUrl || '/images/default-cover.png')}" alt="${escapeAttr(s.title)}" style="width: 38px; height: 38px; border-radius: 6px; object-fit: cover;">
                    <div style="flex: 1; min-width: 0;">
                        <div style="font-size: 0.88rem; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(s.title)}</div>
                        <div style="font-size: 0.76rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(s.artist)}</div>
                    </div>
                    <span style="font-size: 0.78rem; color: var(--text-secondary); margin-right: 8px;">${formatTime(s.durationSeconds)}</span>
                    <button class="song-item-action" onclick="removeSongFromManagedPlaylist(${idx})" title="Remove from playlist">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `).join('');
        }
    }

    if (modal) modal.classList.remove('hidden');
}

function closeManagePlaylistModal() {
    const modal = document.getElementById('manage-playlist-modal');
    if (modal) modal.classList.add('hidden');
    currentManagedPlaylistId = null;
}

function handleManagePlaylistBackdrop(event) {
    if (event.target && event.target.id === 'manage-playlist-modal') {
        closeManagePlaylistModal();
    }
}

function promptRenamePlaylist() {
    if (!currentManagedPlaylistId) return;
    const playlists = getCustomPlaylists();
    const playlist = playlists.find(p => p.id === currentManagedPlaylistId);
    if (!playlist) return;

    const newTitle = prompt('Rename Playlist:', playlist.title);
    if (newTitle && newTitle.trim() && newTitle.trim() !== playlist.title) {
        playlist.title = newTitle.trim();
        playlist.updatedAt = Date.now();
        saveCustomPlaylists(playlists);
        const titleEl = document.getElementById('manage-playlist-title');
        if (titleEl) titleEl.textContent = playlist.title;
        renderCustomPlaylistsUI();
        showToast('Playlist renamed!', 'success');
    }
}

function removeSongFromManagedPlaylist(index) {
    if (!currentManagedPlaylistId) return;
    const playlists = getCustomPlaylists();
    const playlist = playlists.find(p => p.id === currentManagedPlaylistId);
    if (!playlist || !Array.isArray(playlist.songs)) return;

    const removed = playlist.songs.splice(index, 1);
    playlist.updatedAt = Date.now();
    saveCustomPlaylists(playlists);
    showToast(`Removed "${removed[0]?.title || 'song'}"`, 'info');
    openManagePlaylistModal(currentManagedPlaylistId); // Re-render modal
    renderCustomPlaylistsUI();
}

function playCurrentManagedPlaylist(playImmediately) {
    if (!currentManagedPlaylistId) return;
    playCustomPlaylist(currentManagedPlaylistId, playImmediately);
}

function deleteCurrentManagedPlaylist() {
    if (!currentManagedPlaylistId) return;
    deleteCustomPlaylist(currentManagedPlaylistId);
    closeManagePlaylistModal();
}

function deleteCustomPlaylist(playlistId) {
    const playlists = getCustomPlaylists();
    const playlist = playlists.find(p => p.id === playlistId);
    if (!playlist) return;

    if (!confirm(`Are you sure you want to delete playlist "${playlist.title}"?`)) {
        return;
    }

    const updated = playlists.filter(p => p.id !== playlistId);
    saveCustomPlaylists(updated);
    showToast(`Deleted "${playlist.title}"`, 'info');
    renderCustomPlaylistsUI();
}

// ===== Expose functions to global scope for onclick handlers =====
window.createRoom = createRoom;
window.joinRoom = joinRoom;
window.leaveRoom = leaveRoom;
window.togglePlayPause = togglePlayPause;
window.nextSong = nextSong;
window.previousSong = previousSong;
window.playSongAtIndex = playSongAtIndex;
window.seekTo = seekTo;
window.sendChat = sendChat;
window.switchTab = switchTab;
window.goBackInSearch = goBackInSearch;
window.searchExternal = searchExternal;
window.quickSearch = quickSearch;
window.addToQueue = addToQueue;
window.removeFromQueue = removeFromQueue;
window.reorderQueue = reorderQueue;
window.onQueueDragStart = onQueueDragStart;
window.onQueueDragOver = onQueueDragOver;
window.onQueueDrop = onQueueDrop;
window.onQueueDragEnd = onQueueDragEnd;
window.copyRoomCode = copyRoomCode;
window.openListenersModal = openListenersModal;
window.closeListenersModal = closeListenersModal;
window.handleListenersModalBackdrop = handleListenersModalBackdrop;

// Expose playlist functions
window.getCustomPlaylists = getCustomPlaylists;
window.saveCustomPlaylists = saveCustomPlaylists;
window.renderCustomPlaylistsUI = renderCustomPlaylistsUI;
window.playCustomPlaylist = playCustomPlaylist;
window.saveQueueAsPlaylist = saveQueueAsPlaylist;
window.addCurrentSongToPlaylist = addCurrentSongToPlaylist;
window.openAddToPlaylistModal = openAddToPlaylistModal;
window.closeAddToPlaylistModal = closeAddToPlaylistModal;
window.handleAddToPlaylistBackdrop = handleAddToPlaylistBackdrop;
window.addSongToExistingPlaylist = addSongToExistingPlaylist;
window.createPlaylistAndAddSong = createPlaylistAndAddSong;
window.openCreatePlaylistModal = openCreatePlaylistModal;
window.closeCreatePlaylistModal = closeCreatePlaylistModal;
window.handleCreatePlaylistBackdrop = handleCreatePlaylistBackdrop;
window.confirmCreatePlaylist = confirmCreatePlaylist;
window.openManagePlaylistModal = openManagePlaylistModal;
window.closeManagePlaylistModal = closeManagePlaylistModal;
window.handleManagePlaylistBackdrop = handleManagePlaylistBackdrop;
window.promptRenamePlaylist = promptRenamePlaylist;
window.removeSongFromManagedPlaylist = removeSongFromManagedPlaylist;
window.playCurrentManagedPlaylist = playCurrentManagedPlaylist;
window.deleteCurrentManagedPlaylist = deleteCurrentManagedPlaylist;
window.deleteCustomPlaylist = deleteCustomPlaylist;

console.log('All functions exposed to window object including Playlists');

// Enter key handlers for forms
document.addEventListener('DOMContentLoaded', () => {
    updatePlaylistBadges();

    const createUsername = document.getElementById('create-username');
    const createRoomName = document.getElementById('create-room-name');
    const joinUsername = document.getElementById('join-username');
    const joinRoomCode = document.getElementById('join-room-code');

    if (createUsername) createUsername.addEventListener('keypress', e => { if (e.key === 'Enter') createRoom(); });
    if (createRoomName) createRoomName.addEventListener('keypress', e => { if (e.key === 'Enter') createRoom(); });
    if (joinUsername) joinUsername.addEventListener('keypress', e => { if (e.key === 'Enter') document.getElementById('join-room-code').focus(); });
    if (joinRoomCode) joinRoomCode.addEventListener('keypress', e => { if (e.key === 'Enter') joinRoom(); });

    // Attach button click listeners now that functions are defined
    const createRoomBtn = document.getElementById('btn-create-room');
    const joinRoomBtn = document.getElementById('btn-join-room');

    if (createRoomBtn) {
        createRoomBtn.addEventListener('click', (e) => {
            e.preventDefault();
            createRoom();
        });
    }

    if (joinRoomBtn) {
        joinRoomBtn.addEventListener('click', (e) => {
            e.preventDefault();
            joinRoom();
        });
    }

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            closeListenersModal();
            closeAddToPlaylistModal();
            closeCreatePlaylistModal();
            closeManagePlaylistModal();
        }
    });
});
