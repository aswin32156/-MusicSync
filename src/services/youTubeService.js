const API_URL = 'https://www.googleapis.com/youtube/v3';
const MUSIC_WEB_SEARCH_URL = 'https://music.youtube.com/search?q=';
const YOUTUBE_WEB_SEARCH_URL = 'https://www.youtube.com/results?search_query=';

class YouTubeService {
    constructor() {
        this.apiKey = process.env.YOUTUBE_API_KEY ? process.env.YOUTUBE_API_KEY.trim() : '';
        this.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        };
    }

    isApiConfigured() {
        return Boolean(this.apiKey && this.apiKey.length > 20);
    }

    async searchSongs(query, limit = 20) {
        if (!query || !query.trim()) return [];
        const cappedLimit = Math.max(1, Math.min(limit, 50));
        const musicQuery = this.buildMusicQuery(query);
        const seenIds = new Set();
        const songs = [];

        // 1. YouTube Music Web Search
        const musicWebSongs = await this.searchSongsFromYouTubeMusicWeb(musicQuery, cappedLimit);
        for (const s of musicWebSongs) {
            if (!seenIds.has(s.id)) {
                seenIds.add(s.id);
                songs.push(s);
            }
            if (songs.length >= cappedLimit) return songs;
        }

        // 2. YouTube Data API if configured
        if (this.isApiConfigured()) {
            const apiSongs = await this.searchSongsWithApi(musicQuery, cappedLimit);
            for (const s of apiSongs) {
                if (!seenIds.has(s.id)) {
                    seenIds.add(s.id);
                    songs.push(s);
                }
                if (songs.length >= cappedLimit) return songs;
            }
        }

        // 3. Fallback: YouTube Web Search
        if (songs.length === 0) {
            const webSongs = await this.searchSongsFromWeb(musicQuery, cappedLimit);
            for (const s of webSongs) {
                if (!seenIds.has(s.id)) {
                    seenIds.add(s.id);
                    songs.push(s);
                }
                if (songs.length >= cappedLimit) return songs;
            }
        }

        return songs;
    }

    buildVideoSongQuery(query) {
        if (!query) return '';
        const q = query.trim();
        const lower = q.toLowerCase();

        // If user already specified video song / official video / music video
        if (lower.includes('video song') || lower.includes('official video') || lower.includes('music video') || lower.includes('full video')) {
            return q;
        }

        // Replace "audio" or "audio song" with "video song"
        if (lower.includes('audio')) {
            return q.replace(/\baudio\s*songs?\b/gi, 'video song').replace(/\baudio\b/gi, 'video song').trim();
        }

        // If they already have "song" or "songs" (e.g. "Leo songs", "Aashiqui 2 song")
        if (lower.includes('song')) {
            return q.replace(/\bsongs?\b/gi, 'video song').trim();
        }

        // If they typed "video" alone without song
        if (lower.includes('video')) {
            return q + ' song';
        }

        // Standard movie or track name (e.g. "Leo", "Jailer", "Aashiqui 2", "Kesariya", "Dhoom")
        return q + ' video song';
    }

    isValidVideoSong(song) {
        if (!song || !song.title) return false;
        const title = song.title.toLowerCase();

        // Exclude obvious non-song noise (trailers, teasers, speeches, comedy clips, full movies, etc.)
        const junkRegex = /\b(trailer|teaser|promo|preview|public review|movie review|reaction|interview|press meet|audio launch|speech|making of|behind the scenes|fight scene|action scene|comedy scene|climax scene|full movie|movie scenes|jukebox|audio jukebox|songs jukebox)\b/i;
        if (junkRegex.test(title)) {
            return false;
        }

        // Exclude excessively long compilations / movies (> 15 minutes)
        if (song.durationSeconds && song.durationSeconds > 900) {
            return false;
        }

        return true;
    }

    scoreVideoSong(song, query) {
        const title = (song.title || '').toLowerCase();
        let score = 0;

        // Highest priority: official video songs
        if (title.includes('video song') || title.includes('official video') || title.includes('full video')) {
            score += 60;
        }
        if (title.includes('music video') || title.includes('official music video')) {
            score += 50;
        }
        if (title.includes('video')) {
            score += 25;
        }
        if (title.includes('song')) {
            score += 15;
        }

        // Penalize lyric videos if official video songs exist
        if (title.includes('lyric') || title.includes('lyrical')) {
            score -= 20;
        }

        // Query term match boost
        if (query) {
            const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
            for (const word of queryWords) {
                if (title.includes(word)) {
                    score += 10;
                }
            }
        }

        return score;
    }

    async searchVideoContent(query, limit = 20) {
        if (!query || !query.trim()) return [];
        const cappedLimit = Math.max(1, Math.min(limit, 50));
        const videoQuery = this.buildVideoSongQuery(query);
        const seenIds = new Set();
        const songs = [];

        // 1. YouTube Data API if configured
        if (this.isApiConfigured()) {
            const apiSongs = await this.searchVideoContentWithApi(videoQuery, cappedLimit);
            for (const s of apiSongs) {
                if (this.isValidVideoSong(s) && !seenIds.has(s.id)) {
                    seenIds.add(s.id);
                    songs.push(s);
                }
                if (songs.length >= cappedLimit) break;
            }
        }

        // 2. Primary Web search with targeted "video song" query
        if (songs.length < cappedLimit) {
            const webSongs = await this.searchVideoContentFromWeb(videoQuery, cappedLimit);
            for (const s of webSongs) {
                if (this.isValidVideoSong(s) && !seenIds.has(s.id)) {
                    seenIds.add(s.id);
                    songs.push(s);
                }
                if (songs.length >= cappedLimit) break;
            }
        }

        // 3. Fallback / complementary search with "official video" if results are low
        if (songs.length < 10) {
            const cleanBase = query.trim().replace(/\b(video|song|audio)\b/gi, '').trim();
            if (cleanBase.length > 1) {
                const altQuery = cleanBase + ' official video';
                const altSongs = await this.searchVideoContentFromWeb(altQuery, cappedLimit);
                for (const s of altSongs) {
                    if (this.isValidVideoSong(s) && !seenIds.has(s.id)) {
                        seenIds.add(s.id);
                        songs.push(s);
                    }
                    if (songs.length >= cappedLimit) break;
                }
            }
        }

        // Sort video songs by relevance score so top video songs appear first
        songs.sort((a, b) => this.scoreVideoSong(b, query) - this.scoreVideoSong(a, query));

        return songs.slice(0, cappedLimit);
    }

    async fetchVideoOembed(cleanId) {
        try {
            const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${cleanId}&format=json`;
            const res = await fetch(url, { headers: this.headers, signal: AbortSignal.timeout(4000) });
            if (res.ok) {
                const data = await res.json();
                return {
                    title: data.title || 'YouTube Track',
                    artist: data.author_name || 'YouTube',
                    thumbnail: data.thumbnail_url || `https://i.ytimg.com/vi/${cleanId}/hqdefault.jpg`
                };
            }
        } catch (e) {
            // Silently fallback to default
        }
        return null;
    }

    async getSongById(videoId) {
        if (!videoId) return null;
        const cleanId = videoId.replace(/^(yt_|ytv_)/, '');
        const meta = await this.fetchVideoOembed(cleanId);
        return {
            id: 'yt_' + cleanId,
            title: meta ? meta.title : 'YouTube Track',
            artist: meta ? meta.artist : 'YouTube',
            album: 'YouTube Music',
            coverUrl: meta ? meta.thumbnail : `https://i.ytimg.com/vi/${cleanId}/hqdefault.jpg`,
            durationSeconds: 0,
            audioUrl: '',
            addedBy: null
        };
    }

    async getVideoContentById(videoId) {
        if (!videoId) return null;
        const cleanId = videoId.replace(/^(yt_|ytv_)/, '');
        const meta = await this.fetchVideoOembed(cleanId);
        return {
            id: 'ytv_' + cleanId,
            title: meta ? meta.title : 'YouTube Video',
            artist: meta ? meta.artist : 'YouTube',
            album: 'YouTube Video',
            coverUrl: meta ? meta.thumbnail : `https://i.ytimg.com/vi/${cleanId}/hqdefault.jpg`,
            durationSeconds: 0,
            audioUrl: '',
            addedBy: null
        };
    }

    buildMusicQuery(query) {
        const q = query.trim();
        const lower = q.toLowerCase();
        if (lower.includes('audio') || lower.includes('song') || lower.includes('music')) {
            return q;
        }
        return q + ' audio';
    }

    async searchSongsFromYouTubeMusicWeb(query, limit) {
        const songs = [];
        try {
            const url = MUSIC_WEB_SEARCH_URL + encodeURIComponent(query);
            const res = await fetch(url, { headers: this.headers });
            if (!res.ok) return songs;
            const html = await res.text();
            const initialData = this.extractInitialDataJson(html);
            if (!initialData) return songs;

            const renderers = [];
            this.collectMusicRenderers(initialData, renderers);

            const seen = new Set();
            for (const r of renderers) {
                const s = this.parseMusicRenderer(r);
                if (s && !seen.has(s.id)) {
                    seen.add(s.id);
                    songs.push(s);
                }
                if (songs.length >= limit) break;
            }
        } catch (e) {
            // Silently fallback
        }
        return songs;
    }

    async searchSongsFromWeb(query, limit) {
        const songs = [];
        try {
            const url = YOUTUBE_WEB_SEARCH_URL + encodeURIComponent(query);
            const res = await fetch(url, { headers: this.headers });
            if (!res.ok) return songs;
            const html = await res.text();
            const initialData = this.extractInitialDataJson(html);
            if (!initialData) return songs;

            const renderers = [];
            this.collectVideoRenderers(initialData, renderers);

            const seen = new Set();
            for (const r of renderers) {
                const s = this.parseVideoRenderer(r, 'yt_');
                if (s && !seen.has(s.id)) {
                    seen.add(s.id);
                    songs.push(s);
                }
                if (songs.length >= limit) break;
            }
        } catch (e) {
            // Fallback
        }
        return songs;
    }

    async searchVideoContentFromWeb(query, limit) {
        const songs = [];
        try {
            const url = YOUTUBE_WEB_SEARCH_URL + encodeURIComponent(query);
            const res = await fetch(url, { headers: this.headers });
            if (!res.ok) return songs;
            const html = await res.text();
            const initialData = this.extractInitialDataJson(html);
            if (!initialData) return songs;

            const renderers = [];
            this.collectVideoRenderers(initialData, renderers);

            const seen = new Set();
            for (const r of renderers) {
                const s = this.parseVideoRenderer(r, 'ytv_');
                if (s && !seen.has(s.id)) {
                    seen.add(s.id);
                    songs.push(s);
                }
                if (songs.length >= limit) break;
            }
        } catch (e) {
            // Fallback
        }
        return songs;
    }

    async searchSongsWithApi(query, limit) {
        const songs = [];
        try {
            const url = `${API_URL}/search?part=snippet&type=video&videoCategoryId=10&maxResults=${limit}&q=${encodeURIComponent(query)}&key=${encodeURIComponent(this.apiKey)}`;
            const res = await fetch(url);
            if (!res.ok) return songs;
            const data = await res.json();
            if (!data || !Array.isArray(data.items)) return songs;

            for (const item of data.items) {
                const videoId = item.id && item.id.videoId;
                if (!videoId) continue;
                const snippet = item.snippet || {};
                songs.push({
                    id: 'yt_' + videoId,
                    title: snippet.title || 'YouTube Track',
                    artist: snippet.channelTitle || 'YouTube Music',
                    album: 'YouTube Music',
                    coverUrl: (snippet.thumbnails && snippet.thumbnails.high && snippet.thumbnails.high.url) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                    durationSeconds: 0,
                    audioUrl: '',
                    addedBy: null
                });
            }
        } catch (e) {
            // Fallback
        }
        return songs;
    }

    async searchVideoContentWithApi(query, limit) {
        const songs = [];
        try {
            const url = `${API_URL}/search?part=snippet&type=video&maxResults=${limit}&q=${encodeURIComponent(query)}&key=${encodeURIComponent(this.apiKey)}`;
            const res = await fetch(url);
            if (!res.ok) return songs;
            const data = await res.json();
            if (!data || !Array.isArray(data.items)) return songs;

            for (const item of data.items) {
                const videoId = item.id && item.id.videoId;
                if (!videoId) continue;
                const snippet = item.snippet || {};
                songs.push({
                    id: 'ytv_' + videoId,
                    title: snippet.title || 'YouTube Video',
                    artist: snippet.channelTitle || 'YouTube',
                    album: 'YouTube Video',
                    coverUrl: (snippet.thumbnails && snippet.thumbnails.high && snippet.thumbnails.high.url) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                    durationSeconds: 0,
                    audioUrl: '',
                    addedBy: null
                });
            }
        } catch (e) {
            // Fallback
        }
        return songs;
    }

    extractInitialDataJson(html) {
        if (!html) return null;
        const marker = 'var ytInitialData = ';
        let idx = html.indexOf(marker);
        if (idx < 0) {
            const altMarker = 'window["ytInitialData"] = ';
            idx = html.indexOf(altMarker);
            if (idx >= 0) idx += altMarker.length;
        } else {
            idx += marker.length;
        }
        if (idx < 0) return null;

        const endIdx = html.indexOf(';</script>', idx);
        if (endIdx < 0) return null;

        try {
            return JSON.parse(html.substring(idx, endIdx));
        } catch {
            return null;
        }
    }

    collectMusicRenderers(obj, renderers) {
        if (!obj || typeof obj !== 'object') return;
        if (obj.musicResponsiveListItemRenderer) {
            renderers.push(obj.musicResponsiveListItemRenderer);
        }
        for (const key of Object.keys(obj)) {
            this.collectMusicRenderers(obj[key], renderers);
        }
    }

    collectVideoRenderers(obj, renderers) {
        if (!obj || typeof obj !== 'object') return;
        if (obj.videoRenderer) {
            renderers.push(obj.videoRenderer);
        }
        for (const key of Object.keys(obj)) {
            this.collectVideoRenderers(obj[key], renderers);
        }
    }

    parseMusicRenderer(r) {
        if (!r) return null;
        let videoId = (r.playlistItemData && r.playlistItemData.videoId)
            || (r.navigationEndpoint && r.navigationEndpoint.watchEndpoint && r.navigationEndpoint.watchEndpoint.videoId);
        if (!videoId) return null;

        let title = '';
        try {
            const col = r.flexColumns && r.flexColumns[0];
            title = col && col.musicResponsiveListItemFlexColumnRenderer && col.musicResponsiveListItemFlexColumnRenderer.text && col.musicResponsiveListItemFlexColumnRenderer.text.runs && col.musicResponsiveListItemFlexColumnRenderer.text.runs[0] && col.musicResponsiveListItemFlexColumnRenderer.text.runs[0].text;
        } catch {}
        if (!title) title = 'Unknown Title';

        let artist = '';
        try {
            const col = r.flexColumns && r.flexColumns[1];
            artist = col && col.musicResponsiveListItemFlexColumnRenderer && col.musicResponsiveListItemFlexColumnRenderer.text && col.musicResponsiveListItemFlexColumnRenderer.text.runs && col.musicResponsiveListItemFlexColumnRenderer.text.runs[0] && col.musicResponsiveListItemFlexColumnRenderer.text.runs[0].text;
        } catch {}
        if (!artist) artist = 'Unknown Artist';

        return {
            id: 'yt_' + videoId,
            title,
            artist,
            album: 'YouTube Music',
            coverUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            durationSeconds: 0,
            audioUrl: '',
            addedBy: null
        };
    }

    parseVideoRenderer(r, prefix = 'ytv_') {
        if (!r || !r.videoId) return null;
        const videoId = r.videoId;
        let title = (r.title && r.title.runs && r.title.runs[0] && r.title.runs[0].text)
            || (r.title && r.title.simpleText)
            || 'YouTube Video';
        let artist = (r.ownerText && r.ownerText.runs && r.ownerText.runs[0] && r.ownerText.runs[0].text)
            || 'YouTube';

        let durationSeconds = 0;
        const lengthText = (r.lengthText && r.lengthText.simpleText) || '';
        if (lengthText) {
            const parts = lengthText.split(':').map(p => parseInt(p, 10));
            if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                durationSeconds = parts[0] * 60 + parts[1];
            } else if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
                durationSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
            }
        }

        return {
            id: prefix + videoId,
            title,
            artist,
            album: prefix === 'ytv_' ? 'YouTube Video' : 'YouTube Music',
            coverUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            durationSeconds,
            audioUrl: '',
            addedBy: null
        };
    }
}

module.exports = new YouTubeService();
