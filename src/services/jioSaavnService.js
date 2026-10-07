const CryptoJS = require('crypto-js');

class JioSaavnService {
    constructor() {
        this.cookie = process.env.JIOSAAVN_COOKIE ? process.env.JIOSAAVN_COOKIE.trim() : null;
        this.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': 'https://www.jiosaavn.com/',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
            'Origin': 'https://www.jiosaavn.com'
        };
        if (this.cookie) {
            this.headers['Cookie'] = this.cookie;
        }
    }

    async searchSongs(query, limit = 50) {
        if (!query || !query.trim()) return [];
        let results = await this.searchViaGetResults(query.trim(), limit);
        if (results.length > 0) return results;
        return await this.searchViaAutocomplete(query.trim(), limit);
    }

    async searchViaGetResults(query, limit) {
        const results = [];
        try {
            const encoded = encodeURIComponent(query);
            let page = 0;
            let fetched = 0;
            while (fetched < limit && page < 5) {
                const pageSize = Math.min(limit - fetched, 50);
                const url = `https://www.jiosaavn.com/api.php?__call=search.getResults&q=${encoded}&_format=json&_marker=0&p=${page}&n=${pageSize}`;
                const res = await fetch(url, { headers: this.headers });
                if (!res.ok) break;

                let body = await res.text();
                body = this.cleanJsonp(body);
                if (!body || body === '[]' || body === '{}') break;

                let json;
                try {
                    json = JSON.parse(body);
                } catch {
                    break;
                }

                let arr = null;
                if (Array.isArray(json)) {
                    arr = json;
                } else if (json && Array.isArray(json.results)) {
                    arr = json.results;
                }

                if (!arr || arr.length === 0) break;

                for (const item of arr) {
                    const song = this.parseSongElement(item);
                    if (song && song.id) {
                        results.push(song);
                        fetched++;
                        if (fetched >= limit) break;
                    }
                }
                page++;
            }
        } catch (err) {
            console.warn(`JioSaavn searchViaGetResults error for '${query}':`, err.message);
        }
        return results;
    }

    async searchViaAutocomplete(query, limit) {
        const results = [];
        try {
            const encoded = encodeURIComponent(query);
            const url = `https://www.jiosaavn.com/api.php?__call=autocomplete.get&_format=json&_marker=0&cc=in&includeMetaTags=1&query=${encoded}`;
            const res = await fetch(url, { headers: this.headers });
            if (!res.ok) return results;

            let body = await res.text();
            body = this.cleanJsonp(body);
            if (!body || body === '[]' || body === '{}') return results;

            let json;
            try {
                json = JSON.parse(body);
            } catch {
                return results;
            }

            const arr = json && Array.isArray(json.songs) ? json.songs : null;
            if (!arr || arr.length === 0) return results;

            let fetched = 0;
            for (const item of arr) {
                if (fetched >= limit) break;
                const song = this.parseSongElement(item);
                if (song && song.id) {
                    results.push(song);
                    fetched++;
                }
            }
        } catch (err) {
            console.warn(`JioSaavn searchViaAutocomplete error for '${query}':`, err.message);
        }
        return results;
    }

    async getSongById(id) {
        if (!id || !id.trim()) return null;
        try {
            const cleanId = id.startsWith('jio_') ? id.substring(4) : id;
            const url = `https://www.jiosaavn.com/api.php?__call=song.getDetails&pids=${encodeURIComponent(cleanId)}&_format=json&_marker=0`;
            const res = await fetch(url, { headers: this.headers });
            if (!res.ok) return null;

            let body = await res.text();
            body = this.cleanJsonp(body);
            if (!body || body === '[]' || body === '{}') return null;

            let json;
            try {
                json = JSON.parse(body);
            } catch {
                return null;
            }

            if (Array.isArray(json)) {
                for (const item of json) {
                    const s = this.parseSongObject(item);
                    if (s) return s;
                }
                return null;
            }

            if (json[cleanId] && typeof json[cleanId] === 'object') {
                const s = this.parseSongObject(json[cleanId]);
                if (s) return s;
            }

            for (const key of Object.keys(json)) {
                if (json[key] && typeof json[key] === 'object') {
                    const s = this.parseSongObject(json[key]);
                    if (s) return s;
                }
            }
        } catch (err) {
            console.warn(`JioSaavn getSongById error for '${id}':`, err.message);
        }
        return null;
    }

    cleanJsonp(body) {
        if (!body) return '';
        let trimmed = body.trim();
        if (trimmed.startsWith('function') || trimmed.startsWith('__')) {
            const start = trimmed.indexOf('{');
            const end = trimmed.lastIndexOf('}');
            if (start >= 0 && end >= 0) {
                trimmed = trimmed.substring(start, end + 1);
            }
        }
        return trimmed;
    }

    parseSongElement(elem) {
        if (!elem || typeof elem !== 'object') return null;
        if (elem.id) return this.parseSongObject(elem);
        if (elem.song && typeof elem.song === 'object') return this.parseSongObject(elem.song);
        return null;
    }

    parseSongObject(song) {
        if (!song || typeof song !== 'object') return null;
        const rawId = song.id || song.songId;
        if (!rawId) return null;

        const id = 'jio_' + rawId;
        let title = song.title || song.song || song.name || '';
        title = this.cleanText(title);

        let artist = '';
        if (Array.isArray(song.primary_artists)) {
            artist = song.primary_artists.map(a => a && a.name ? a.name : '').filter(Boolean).join(', ');
        } else if (typeof song.primary_artists === 'string' && song.primary_artists.trim()) {
            artist = song.primary_artists.trim();
        } else if (song.more_info && typeof song.more_info === 'object') {
            if (song.more_info.primary_artists) artist = String(song.more_info.primary_artists).trim();
            else if (song.more_info.singers) artist = String(song.more_info.singers).trim();
        }
        if (!artist) artist = 'Unknown Artist';
        artist = this.cleanText(artist);

        let album = this.cleanText(song.album || (song.more_info && song.more_info.album) || '');
        let coverUrl = song.image || song.album_pic || '';
        if (coverUrl && coverUrl.includes('150x150')) {
            // Can upgrade thumbnail resolution to 500x500 for better display
            coverUrl = coverUrl.replace('150x150', '500x500');
        }

        let durationSeconds = 0;
        if (song.duration) durationSeconds = parseInt(song.duration, 10) || 0;
        else if (song.length) durationSeconds = parseInt(song.length, 10) || 0;

        let audioUrl = null;
        let encryptedUrl = (song.more_info && song.more_info.encrypted_media_url)
            || (song.more_info && song.more_info.encrypted_media_path)
            || song.encrypted_media_url
            || song.encrypted_media_path;

        if (encryptedUrl && typeof encryptedUrl === 'string') {
            audioUrl = this.decryptMediaUrl(encryptedUrl);
        }

        if (!audioUrl) {
            audioUrl = song.vlink || (song.more_info && song.more_info.vlink) || song.media_preview_url || '';
        }

        if (!audioUrl) {
            audioUrl = id;
        }

        return {
            id,
            title,
            artist,
            album,
            coverUrl,
            durationSeconds,
            audioUrl,
            addedBy: null
        };
    }

    decryptMediaUrl(encryptedUrl) {
        if (!encryptedUrl || typeof encryptedUrl !== 'string') return null;
        const trimmed = encryptedUrl.trim();
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;

        try {
            const key = CryptoJS.enc.Utf8.parse('38346591');
            const decrypted = CryptoJS.DES.decrypt(trimmed, key, {
                mode: CryptoJS.mode.ECB,
                padding: CryptoJS.pad.Pkcs7
            });
            let url = decrypted.toString(CryptoJS.enc.Utf8).trim();

            const mp4Idx = url.indexOf('.mp4');
            if (mp4Idx >= 0) {
                url = url.substring(0, mp4Idx + 4);
            } else {
                const m4aIdx = url.indexOf('.m4a');
                if (m4aIdx >= 0) url = url.substring(0, m4aIdx + 4);
            }

            url = url.replace('http:', 'https:');
            if (url.startsWith('http')) {
                return url;
            }
        } catch (e) {
            // Decryption failure
        }
        return null;
    }

    cleanText(str) {
        if (!str) return '';
        return String(str)
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&#039;/g, "'")
            .replace(/&apos;/g, "'");
    }
}

module.exports = new JioSaavnService();
