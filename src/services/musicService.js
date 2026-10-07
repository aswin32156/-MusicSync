const jioSaavnService = require('./jioSaavnService');
const youTubeService = require('./youTubeService');

class MusicService {
    constructor() {
        this.library = [
            { id: "1", title: "Blinding Lights", artist: "The Weeknd", album: "After Hours", coverUrl: "https://i.scdn.co/image/ab67616d0000b2738863bc11d2aa12b54f5aeb36", durationSeconds: 200, audioUrl: "https://cdn.pixabay.com/audio/2022/05/27/audio_1808fbf07a.mp3" },
            { id: "2", title: "Starboy", artist: "The Weeknd ft. Daft Punk", album: "Starboy", coverUrl: "https://i.scdn.co/image/ab67616d0000b273a048415d3328299c565cf565", durationSeconds: 230, audioUrl: "https://cdn.pixabay.com/audio/2022/10/11/audio_2ceb382e2e.mp3" },
            { id: "3", title: "Shape of You", artist: "Ed Sheeran", album: "÷ (Divide)", coverUrl: "https://i.scdn.co/image/ab67616d0000b273ba5db46f4b838ef6027e6f96", durationSeconds: 234, audioUrl: "https://cdn.pixabay.com/audio/2022/01/18/audio_d0a13f69d2.mp3" },
            { id: "4", title: "Levitating", artist: "Dua Lipa", album: "Future Nostalgia", coverUrl: "https://i.scdn.co/image/ab67616d0000b273bd26ede1ae69327010d49946", durationSeconds: 203, audioUrl: "https://cdn.pixabay.com/audio/2021/11/25/audio_91b32e02f9.mp3" },
            { id: "5", title: "Save Your Tears", artist: "The Weeknd", album: "After Hours", coverUrl: "https://i.scdn.co/image/ab67616d0000b2738863bc11d2aa12b54f5aeb36", durationSeconds: 216, audioUrl: "https://cdn.pixabay.com/audio/2022/03/15/audio_115b9b3f25.mp3" },
            { id: "6", title: "Watermelon Sugar", artist: "Harry Styles", album: "Fine Line", coverUrl: "https://i.scdn.co/image/ab67616d0000b273b46f74097655d7f353caab14", durationSeconds: 174, audioUrl: "https://cdn.pixabay.com/audio/2022/08/04/audio_2dae668d83.mp3" },
            { id: "7", title: "drivers license", artist: "Olivia Rodrigo", album: "SOUR", coverUrl: "https://i.scdn.co/image/ab67616d0000b273a91c10fe9472d9bd535571d7", durationSeconds: 242, audioUrl: "https://cdn.pixabay.com/audio/2023/05/16/audio_166b39b10a.mp3" },
            { id: "8", title: "Peaches", artist: "Justin Bieber", album: "Justice", coverUrl: "https://i.scdn.co/image/ab67616d0000b273e6f407c7f3a0ec98845e4431", durationSeconds: 198, audioUrl: "https://cdn.pixabay.com/audio/2022/06/07/audio_b9bd4170e4.mp3" },
            { id: "9", title: "Good 4 U", artist: "Olivia Rodrigo", album: "SOUR", coverUrl: "https://i.scdn.co/image/ab67616d0000b273a91c10fe9472d9bd535571d7", durationSeconds: 178, audioUrl: "https://cdn.pixabay.com/audio/2023/09/04/audio_0e8a28a08c.mp3" },
            { id: "10", title: "Stay", artist: "The Kid LAROI & Justin Bieber", album: "F*CK LOVE 3", coverUrl: "https://i.scdn.co/image/ab67616d0000b273a05a950d122466ffd3294d6a", durationSeconds: 141, audioUrl: "https://cdn.pixabay.com/audio/2022/11/22/audio_febc508520.mp3" },
            { id: "11", title: "Montero", artist: "Lil Nas X", album: "MONTERO", coverUrl: "https://i.scdn.co/image/ab67616d0000b273be82673b5f79d9658ec0a9fd", durationSeconds: 137, audioUrl: "https://cdn.pixabay.com/audio/2022/04/27/audio_67bcb4e1c1.mp3" },
            { id: "12", title: "Heat Waves", artist: "Glass Animals", album: "Dreamland", coverUrl: "https://i.scdn.co/image/ab67616d0000b273712701c5e263efc8726b1464", durationSeconds: 239, audioUrl: "https://cdn.pixabay.com/audio/2023/07/30/audio_e5b1a26c75.mp3" }
        ];

        this.externalSongsCache = new Map();
        this.externalSearchCache = new Map();
        this.SEARCH_CACHE_TTL_MS = 60000;
    }

    getLibrary() {
        return [...this.library];
    }

    cacheSong(song) {
        if (song && song.id) {
            this.externalSongsCache.set(song.id, song);
        }
    }

    async getSongById(id) {
        if (!id) return null;

        // 1. Check local library
        const local = this.library.find(s => s.id === id);
        if (local) return { ...local };

        // 2. Check cache
        const cached = this.externalSongsCache.get(id);
        if (cached) {
            let needsReResolve = false;
            const audio = cached.audioUrl;
            if (id.startsWith('jio_') && (!audio || audio.startsWith('jio_') || audio.includes('preview') || audio.includes('jiotune'))) {
                needsReResolve = true;
            }
            if (!needsReResolve) return { ...cached };
        }

        // 3. Resolve from external services
        if (id.startsWith('jio_')) {
            const cleanId = id.substring(4);
            const song = await jioSaavnService.getSongById(cleanId);
            if (song) {
                this.cacheSong(song);
                return song;
            }
        } else if (id.startsWith('ytv_')) {
            const song = await youTubeService.getVideoContentById(id.substring(4));
            if (song) {
                this.cacheSong(song);
                return song;
            }
        } else if (id.startsWith('yt_')) {
            const song = await youTubeService.getSongById(id.substring(3));
            if (song) {
                this.cacheSong(song);
                return song;
            }
        }

        return cached ? { ...cached } : null;
    }

    searchLocalLibrary(query) {
        if (!query || !query.trim()) return this.getLibrary();
        const q = query.trim().toLowerCase();
        return this.library.filter(s =>
            (s.title && s.title.toLowerCase().includes(q)) ||
            (s.artist && s.artist.toLowerCase().includes(q)) ||
            (s.album && s.album.toLowerCase().includes(q))
        );
    }

    async searchExternal(query, limit = 200) {
        if (!query || !query.trim()) return [];

        const normalizedQuery = query.trim();
        const searchKey = normalizedQuery.toLowerCase() + '#' + limit;
        const now = Date.now();

        const cached = this.externalSearchCache.get(searchKey);
        if (cached && (now - cached.cachedAt) < this.SEARCH_CACHE_TTL_MS) {
            return cached.results.map(s => ({ ...s }));
        }

        const providerLimit = Math.max(6, Math.min(limit, 200));

        // Fetch JioSaavn, YouTube Music, and YouTube Videos in parallel
        const [jioResults, ytMusicResults, ytVideoResults] = await Promise.all([
            jioSaavnService.searchSongs(normalizedQuery, providerLimit).catch(() => []),
            youTubeService.searchSongs(normalizedQuery, providerLimit).catch(() => []),
            youTubeService.searchVideoContent(normalizedQuery, providerLimit).catch(() => [])
        ]);

        const seenIds = new Set();
        const results = [];

        // Add YouTube Music
        for (const s of ytMusicResults) {
            if (s && s.id && !seenIds.has(s.id)) {
                seenIds.add(s.id);
                results.push(s);
                this.cacheSong(s);
            }
        }

        // Add YouTube Video
        for (const s of ytVideoResults) {
            if (s && s.id && !seenIds.has(s.id)) {
                seenIds.add(s.id);
                results.push(s);
                this.cacheSong(s);
            }
        }

        // Add JioSaavn
        for (const s of jioResults) {
            if (s && s.id && !seenIds.has(s.id)) {
                seenIds.add(s.id);
                results.push(s);
                this.cacheSong(s);
            }
        }

        if (results.length > 0) {
            this.externalSearchCache.set(searchKey, {
                cachedAt: now,
                results: results.map(s => ({ ...s }))
            });
        }

        return results;
    }

    getAvailableSources() {
        return {
            sources: ['jiosaavn', 'youtube', 'youtubevideo'],
            jiosaavn: true,
            jiosaavnConfigured: true,
            youtube: true,
            youtubeConfigured: true,
            spotify: false,
            spotifyConfigured: false
        };
    }
}

module.exports = new MusicService();
