function loadLocalConfig() {
    const cfg = {};
    try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', 'config.local.js', false);
        xhr.send();
        if (xhr.status !== 200) return cfg;
        const text = xhr.responseText;
        const re = /window\.__(\w+)__\s*=\s*([\s\S]*?);/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            try {
                cfg[m[1]] = new Function('return (' + m[2] + ');')();
            } catch { /* ignore malformed entry */ }
        }
    } catch { /* file absent or fetch blocked */ }
    return cfg;
}

const LOCAL_CONFIG = loadLocalConfig();

const CONFIG = {
    PROVIDER: LOCAL_CONFIG.PODCAST_PROVIDER || window.__PODCAST_PROVIDER__ || 'listennotes',
    API_KEY: LOCAL_CONFIG.PODCAST_API_KEY || window.__PODCAST_API_KEY__ || '',
    BASE_URL: LOCAL_CONFIG.PODCAST_BASE_URL || window.__PODCAST_BASE_URL__ || 'https://listen-api-test.listennotes.com/api/v2',
    PI_KEY: LOCAL_CONFIG.PODCAST_PI_KEY || window.__PODCAST_PI_KEY__ || '',
    PI_SECRET: LOCAL_CONFIG.PODCAST_PI_SECRET || window.__PODCAST_PI_SECRET__ || '',
    PI_BASE_URL: LOCAL_CONFIG.PODCAST_PI_BASE_URL || window.__PODCAST_PI_BASE_URL__ || 'https://api.podcastindex.org/api/1.0',
    DEBOUNCE_DELAY: 300,
    RESUME_OFFSET: 10,
};

const IS_PI = CONFIG.PROVIDER === 'podcastindex';

// SHA-1 hex digest (used for Podcast Index request signing) via Web Crypto
async function sha1Hex(str) {
    const bytes = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const PROGRESS_KEY = 'podcast_progress';
const PLAYER_KEY = 'podcast_player';


const storage = {
    get(key, fallback = null) {
        try {
            const item = localStorage.getItem(key);
            return item ? JSON.parse(item) : fallback;
        } catch {
            return fallback;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {
            // Storage full or unavailable
        }
    },
};

class PodcastApp {
    constructor() {
        this.currentPage = 'landing';
        this.searchQuery = '';
        this.currentPodcastId = null;
        this.currentEpisodePubDate = null;
        this.playlist = storage.get('podcast_playlist', []);
        this.audio = new Audio();
        this.audio.preload = 'metadata';
        this.currentPageNum = 0;
        this.nextPageNumber = 1;
        this.nextOffset = 0;
        this.hasMore = true;
        this.isSearching = false;
        this.searchTimeout = null;
        this.currentEpisodeId = null;
        this.currentPlayerEpisode = null;
        this.navStack = [];

        this.cache = new Map();
        this.cacheTTL = 5 * 60 * 1000;

        this.pendingRequests = new Map();
        this.lastRequestTime = 0;
        this.minRequestInterval = IS_PI ? 0 : 1100;

        this.init();
    }

    async apiFetch(url) {
        const cached = this.cache.get(url);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
            return cached.data;
        }
        if (this.pendingRequests.has(url)) {
            return this.pendingRequests.get(url);
        }
        const promise = this.throttledFetch(url);
        this.pendingRequests.set(url, promise);
        try {
            return await promise;
        } finally {
            this.pendingRequests.delete(url);
        }
    }

    async throttledFetch(url) {
        const wait = this.minRequestInterval - (Date.now() - this.lastRequestTime);
        if (wait > 0) {
            await new Promise(resolve => setTimeout(resolve, wait));
        }
        return this.fetchWithRetry(url);
    }

    async buildAuthHeaders() {
        const headers = { 'Accept': 'application/json' };
        if (IS_PI) {
            if (CONFIG.PI_KEY && CONFIG.PI_SECRET) {
                const authDate = Math.floor(Date.now() / 1000);
                headers['X-Auth-Key'] = CONFIG.PI_KEY;
                headers['X-Auth-Date'] = String(authDate);
                headers['Authorization'] = await sha1Hex(CONFIG.PI_KEY + CONFIG.PI_SECRET + authDate);
            }
        } else if (CONFIG.API_KEY) {
            headers['X-ListenAPI-Key'] = CONFIG.API_KEY;
        }
        return headers;
    }

    async fetchWithRetry(url, attempt = 0) {
        const maxAttempts = 3;
        const baseDelay = 1000;
        this.lastRequestTime = Date.now();
        const headers = await this.buildAuthHeaders();
        const res = await fetch(url, { headers });
        if (res.status === 429) {
            if (attempt >= maxAttempts) throw new Error(`API error: ${res.status}`);
            const delay = baseDelay * Math.pow(2, attempt);
            await new Promise(resolve => setTimeout(resolve, delay));
            return this.fetchWithRetry(url, attempt + 1);
        }
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const data = await res.json();
        this.cache.set(url, { data, timestamp: Date.now() });
        return data;
    }

    // Normalize a Podcast Index feed into the shape the UI expects 
    normFeed(f) {
        return {
            id: f.id,
            name: f.title,
            title: f.title,
            publisher: f.author || f.ownerName,
            image: f.image || f.artwork,
            description: f.description,
        };
    }

    // Normalize a Podcast Index episode item into the shape the UI expects
    normEpisode(it, feed) {
        return {
            id: String(it.id),
            title: it.title,
            audio: it.enclosureUrl,
            publish_date: it.datePublished ? it.datePublished * 1000 : null,
            duration: it.duration,
            description: it.description,
            podcast: (feed && feed.title) || it.feedTitle || '',
            podcast_image: (feed && (feed.image || feed.artwork)) || it.feedImage || it.image,
        };
    }

    async loadBestPodcasts(page) {
        if (IS_PI) {
            const data = await this.apiFetch(`${CONFIG.PI_BASE_URL}/podcasts/trending?max=40&lang=en`);
            return { podcasts: (data.feeds || []).map(f => this.normFeed(f)), next_page_number: null };
        }
        const url = `${CONFIG.BASE_URL}/best_podcasts?sort=recent_published_first&page=${page}`;
        return this.apiFetch(url);
    }

    async loadPodcastEpisodes(id, pubDate) {
        if (IS_PI) {
            const [podRes, epRes] = await Promise.all([
                this.apiFetch(`${CONFIG.PI_BASE_URL}/podcasts/byfeedid?id=${id}`),
                this.apiFetch(`${CONFIG.PI_BASE_URL}/episodes/byfeedid?id=${id}&max=50`),
            ]);
            const feed = podRes.feed || {};
            return {
                podcast: {
                    id: feed.id,
                    name: feed.title,
                    title: feed.title,
                    image: feed.image || feed.artwork,
                    description: feed.description,
                },
                episodes: (epRes.items || []).map(it => this.normEpisode(it, feed)),
                next_episode_pub_date: null,
            };
        }
        let url = `${CONFIG.BASE_URL}/podcasts/${id}`;
        if (pubDate) {
            url += `?next_episode_pub_date=${pubDate}`;
        }
        return this.apiFetch(url);
    }

    el(id) {
        return document.getElementById(id);
    }

    init() {
        this.bindEvents();
        this.renderPlaylist();
        this.restorePlayer();
        this.loadPodcasts();
        this.setupAudio();
        this.setupRouter();
    }

    setupRouter() {
        window.addEventListener('hashchange', () => this.handleRoute());
        this.handleRoute();
    }

    parseHash() {
        const hash = window.location.hash.replace(/^#/, '');
        if (hash.startsWith('/podcast/')) {
            const id = hash.slice('/podcast/'.length);
            return { page: 'details', id: id || null };
        }
        if (hash === '/playlist') return { page: 'playlist' };
        return { page: 'landing' };
    }

    handleRoute() {
        const { page, id } = this.parseHash();
        if (page === 'details' && id) {
            this.transitionPage('details');
            this.currentPodcastId = id;
            this.showPodcastDetails(id);
        } else {
            this.currentPodcastId = null;
            this.currentEpisodePubDate = null;
            this.transitionPage(page);
            if (page === 'playlist') {
                this.renderPlaylist();
            }
        }
        this.updateBackButtons(page);
    }

    routeFor(page, state = {}) {
        if (page === 'details') return `#/podcast/${state.id || ''}`;
        if (page === 'playlist') return '#/playlist';
        return '#/';
    }

    updateBackButtons(page) {
        const canGoBack = this.navStack.length > 0;
        document.querySelectorAll('.back-button').forEach(btn => {
            
            btn.style.display = (page === 'landing' && !canGoBack) ? 'none' : '';
        });
    }

    goBack() {
        if (this.navStack.length === 0) {
            if (this.parseHash().page !== 'landing') this.navigateTo('landing');
            return;
        }
        const prev = this.navStack.pop();
        const target = this.routeFor(prev.page, prev);
        if (window.location.hash === target) {
            this.handleRoute();
        } else {
            window.location.hash = target;
        }
    }

    bindEvents() {
        const searchInput = this.el('search-input');
        const navHome = this.el('nav-home');
        const navPlaylist = this.el('nav-playlist');
        const backButton = this.el('back-button');
        const playPauseBtn = this.el('play-pause-btn');
        const rewindBtn = this.el('rewind-btn');
        const forwardBtn = this.el('forward-btn');
        const progressBar = this.el('progress-bar');
        const playlistToggleBtn = this.el('playlist-toggle-btn');
        const closePlayerBtn = this.el('close-player-btn');

        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                clearTimeout(this.searchTimeout);
                const q = e.target.value.trim();
                this.searchTimeout = setTimeout(() => {
                    if (q) {
                        this.navigateTo('landing');
                        this.isSearching = true;
                        this.currentPageNum = 0;
                        this.nextPageNumber = 1;
                        this.nextOffset = 0;
                        this.searchQuery = q;
                        this.hasMore = true;
                        const grid = this.el('podcast-grid');
                        if (grid) grid.innerHTML = '';
                        this.loadSearchResults(q);
                    } else {
                        this.isSearching = false;
                        this.currentPageNum = 0;
                        this.nextPageNumber = 1;
                        this.nextOffset = 0;
                        this.searchQuery = '';
                        this.hasMore = true;
                        const grid = this.el('podcast-grid');
                        if (grid) grid.innerHTML = '';
                        this.loadPodcasts();
                    }
                }, CONFIG.DEBOUNCE_DELAY);
            });
        }

        if (navHome) {
            navHome.addEventListener('click', () => this.navigateTo('landing'));
        }
        if (navPlaylist) {
            navPlaylist.addEventListener('click', () => this.navigateTo('playlist'));
        }
        document.querySelectorAll('.back-button').forEach(btn => {
            btn.addEventListener('click', () => this.goBack());
        });

        if (playPauseBtn) {
            playPauseBtn.addEventListener('click', () => this.togglePlay());
        }
        if (rewindBtn) {
            rewindBtn.addEventListener('click', () => this.seek(-15));
        }
        if (forwardBtn) {
            forwardBtn.addEventListener('click', () => this.seek(15));
        }
        if (progressBar) {
            progressBar.addEventListener('click', (e) => {
                const rect = progressBar.getBoundingClientRect();
                const pct = (e.clientX - rect.left) / rect.width;
                this.audio.currentTime = pct * this.audio.duration;
            });
        }
        if (playlistToggleBtn) {
            playlistToggleBtn.addEventListener('click', () => this.togglePlaylistBtn());
        }
        if (closePlayerBtn) {
            closePlayerBtn.addEventListener('click', () => this.closePlayer());
        }

       
        window.addEventListener('scroll', () => this.handleScroll());

       
        document.addEventListener('keydown', (e) => {
            if ((e.code === 'Space' || e.key === ' ') && !e.target.matches('input, textarea')) {
                e.preventDefault();
                this.togglePlay();
            }
        });
    }

    setupAudio() {
        this.audio.addEventListener('timeupdate', () => {
            if (this.audio.duration) {
                const pct = (this.audio.currentTime / this.audio.duration) * 100;
                const progressFill = this.el('progress-fill');
                const currentTimeEl = this.el('current-time');
                if (progressFill) progressFill.style.width = `${pct}%`;
                if (currentTimeEl) currentTimeEl.textContent = this.formatTime(this.audio.currentTime);

                
                if (this.currentEpisodeId && this.audio.currentTime > 5) {
                    this.saveProgress(this.currentEpisodeId, this.audio.currentTime);
                }
                this.savePlayerState();
            }
        });

        this.audio.addEventListener('loadedmetadata', () => {
            const totalTimeEl = this.el('total-time');
            if (totalTimeEl) totalTimeEl.textContent = this.formatTime(this.audio.duration);
        });

        this.audio.addEventListener('play', () => {
            const playPauseBtn = this.el('play-pause-btn');
            if (playPauseBtn) playPauseBtn.textContent = '⏸';
        });

        this.audio.addEventListener('pause', () => {
            const playPauseBtn = this.el('play-pause-btn');
            if (playPauseBtn) playPauseBtn.textContent = '▶';
        });

        this.audio.addEventListener('ended', () => {
            const playPauseBtn = this.el('play-pause-btn');
            const progressFill = this.el('progress-fill');
            if (playPauseBtn) playPauseBtn.textContent = '▶';
            if (progressFill) progressFill.style.width = '0%';
            this.currentEpisodeId = null;
        });
    }

    

    navigateTo(page, state = {}) {
        const current = this.parseHash();
        const sameRoute = current.page === page &&
            (page !== 'details' || current.id === (state.id || null));
        if (sameRoute) {
            this.handleRoute();
            return;
        }
        // Remember where we came from so Back can return there
        this.navStack.push(current);
        window.location.hash = this.routeFor(page, state);
    }

    transitionPage(page) {
        const pages = document.querySelectorAll('.page');
        const activePage = document.querySelector('.page.active');

        
        if (activePage) {
            activePage.style.opacity = '0';
            activePage.style.transform = 'translateY(-10px)';
        }

        setTimeout(() => {
            pages.forEach(p => {
                p.classList.remove('active');
                p.style.opacity = '';
                p.style.transform = '';
            });

            const target = this.el(`${page}-page`);
            if (target) {
                target.classList.add('active');
                // Animate in
                target.style.opacity = '0';
                target.style.transform = 'translateY(10px)';
                requestAnimationFrame(() => {
                    target.style.opacity = '';
                    target.style.transform = '';
                });
            }

            this.currentPage = page;

            
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }, 150);
    }

    showLoading(show) {
        const indicator = this.el('loading-indicator');
        if (indicator) indicator.style.display = show ? 'block' : 'none';
    }

    renderPodcasts(podcasts) {
        const grid = this.el('podcast-grid');
        podcasts.forEach(podcast => {
            const card = document.createElement('div');
            card.className = 'podcast-card';
            const author = podcast.publisher || podcast.creator || 'Unknown';
            card.innerHTML = `
                <img src="${this.escape(this.safeUrl(podcast.image))}" alt="${this.escape(podcast.name || podcast.title || podcast.title_original)}" />
                <h3>${this.escape(podcast.name || podcast.title || podcast.title_original)}</h3>
                <span class="podcast-author">${this.escape(author)}</span>
                ${this.isSearching ? '<span class="search-badge">☆</span>' : ''}
                <p>${this.escape(podcast.description)}</p>
            `;
            if (podcast.id) {
                card.style.cursor = 'pointer';
                card.addEventListener('click', () => {
                    this.navigateTo('details', { id: podcast.id });
                });
            }
            const btn = card.querySelector('.detail-btn');
            if (btn && podcast.id) {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.navigateTo('details', { id: podcast.id });
                });
            }
            grid.appendChild(card);
        });
    }

    async showPodcastDetails(id) {
        this.currentPodcastId = id;
        this.currentEpisodePubDate = null;
        this.showLoading(true);

        try {
            const data = await this.loadPodcastEpisodes(id);
            const episodes = data.episodes || [];

           
            const podcast = data.podcast || {};
            if (podcast.name || podcast.title || podcast.title_original) {
                const podcastDetails = this.el('podcast-details');
                if (podcastDetails) {
                    podcastDetails.innerHTML = `
                        <div class="podcast-hero">
                            <img src="${this.escape(this.safeUrl(podcast.image))}" alt="${this.escape(podcast.name || podcast.title || podcast.title_original)}" />
                            <div class="podcast-hero-info">
                                <h2>${this.escape(podcast.name || podcast.title || podcast.title_original)}</h2>
                                <p>${this.escape(podcast.description)}</p>
                            </div>
                        </div>
                    `;
                }
            }

           
            const list = this.el('episodes-list');
            if (!list) return;
            list.innerHTML = '';
            episodes.forEach(ep => {
                const item = document.createElement('div');
                item.className = 'episode-item';
                const isInPlaylist = this.playlist.some(e => e.id === ep.id);
                item.innerHTML = `
                    <div class="episode-header">
                        <h3>${this.escape(ep.title)}</h3>
                        <div class="episode-meta">
                            <span class="episode-date">${this.formatDate(ep.publish_date)}</span>
                            ${ep.duration ? `<span class="episode-duration">${this.formatDuration(ep.duration)}</span>` : ''}
                        </div>
                    </div>
                    <p>${this.escape(ep.description)}</p>
                    <div class="episode-actions">
                        <button class="play-btn" data-id="${ep.id}" data-url="${this.escape(ep.audio)}" data-title="${this.escape(ep.title)}" data-podcast="${this.escape(ep.podcast)}" data-image="${this.escape(this.safeUrl(ep.podcast_image))}">▶ Play</button>
                        <button class="add-btn" data-id="${ep.id}" data-url="${this.escape(ep.audio)}" data-title="${this.escape(ep.title)}" data-podcast="${this.escape(ep.podcast)}" data-image="${this.escape(this.safeUrl(ep.podcast_image))}">${isInPlaylist ? '✓ In List' : '+ Add'}</button>
                    </div>
                `;
                list.appendChild(item);
            });

            
            list.querySelectorAll('.play-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    this.playEpisode(btn.dataset.url, btn.dataset.title, btn.dataset.podcast, btn.dataset.id, btn.dataset.image);
                });
            });

           
            list.querySelectorAll('.add-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    this.addToPlaylist({
                        id: btn.dataset.id,
                        title: btn.dataset.title,
                        podcast: btn.dataset.podcast,
                        audio: btn.dataset.url,
                        image: btn.dataset.image,
                    });
                    btn.textContent = '✓ In List';
                    btn.disabled = true;
                });
            });

            
            this.currentEpisodePubDate = data.next_episode_pub_date || null;
        } catch (err) {
            console.error(err);
            const podcastDetails = this.el('podcast-details');
            if (podcastDetails) {
                podcastDetails.innerHTML = '<p style="color:#ff4444">Failed to load podcast details.</p>';
            }
        } finally {
            this.showLoading(false);
        }
    }

    renderPlaylist() {
        const container = this.el('playlist-items');
        const empty = this.el('playlist-empty');
        if (!container || !empty) return;
        container.innerHTML = '';

        if (this.playlist.length === 0) {
            empty.style.display = 'block';
            container.style.display = 'none';
            return;
        }

        empty.style.display = 'none';
        container.style.display = 'block';

        this.playlist.forEach((ep, idx) => {
            const item = document.createElement('div');
            item.className = 'playlist-item';
            item.innerHTML = `
                <div class="playlist-item-info">
                    <strong>${this.escape(ep.title)}</strong>
                    <span>${this.escape(ep.podcast)}</span>
                </div>
                <div class="playlist-item-actions">
                    <button class="play-btn" data-id="${ep.id}" data-url="${this.escape(ep.audio)}" data-title="${this.escape(ep.title)}" data-podcast="${this.escape(ep.podcast)}" data-image="${this.escape(this.safeUrl(ep.image))}">▶</button>
                    <button class="remove-btn" data-idx="${idx}">✕</button>
                </div>
            `;
            container.appendChild(item);
        });

        container.querySelectorAll('.play-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.playEpisode(btn.dataset.url, btn.dataset.title, btn.dataset.podcast, btn.dataset.id, btn.dataset.image);
            });
        });

        container.querySelectorAll('.remove-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.playlist.splice(parseInt(btn.dataset.idx), 1);
                storage.set('podcast_playlist', this.playlist);
                this.renderPlaylist();
            });
        });
    }

    

    playEpisode(url, title, podcast, episodeId, image) {
        this.audio.src = url;
        this.audio.play().catch(() => {
            // Autoplay may be blocked until user interacts; ignore silently.
        });
        const player = this.el('player');
        if (player) player.classList.remove('hidden');
        const playerTitle = this.el('player-title');
        const playerPodcast = this.el('player-podcast');
        if (playerTitle) playerTitle.textContent = title;
        if (playerPodcast) playerPodcast.textContent = podcast;
        this.currentEpisodeId = episodeId;
        this.currentPlayerEpisode = { id: episodeId, title, podcast, audio: url, image: image || '' };
        this.savePlayerState();

        // Restore saved position with 10s offset once metadata is available
        const saved = this.getProgress(episodeId);
        if (saved > 5) {
            const resumeAt = Math.max(0, saved - CONFIG.RESUME_OFFSET);
            this.audio.addEventListener('loadedmetadata', () => {
                if (resumeAt < this.audio.duration) {
                    this.audio.currentTime = resumeAt;
                }
            }, { once: true });
        }
    }

    togglePlay() {
        if (this.audio.paused) {
            this.audio.play().catch(() => {});
        } else {
            this.audio.pause();
        }
    }

    seek(seconds) {
        this.audio.currentTime = Math.max(0, this.audio.currentTime + seconds);
    }

   

    getProgress(episodeId) {
        const data = storage.get(PROGRESS_KEY, {});
        return data[episodeId] || 0;
    }

    saveProgress(episodeId, position) {
        const data = storage.get(PROGRESS_KEY, {});
        data[episodeId] = position;
        storage.set(PROGRESS_KEY, data);
    }

    savePlayerState() {
        if (!this.currentPlayerEpisode) return;
        storage.set(PLAYER_KEY, {
            ...this.currentPlayerEpisode,
            position: this.audio.currentTime || 0,
        });
    }

    restorePlayer() {
        const ep = storage.get(PLAYER_KEY, null);
        if (!ep || !ep.id) return;
        this.currentPlayerEpisode = ep;
        this.currentEpisodeId = ep.id;
        const player = this.el('player');
        if (player) player.classList.remove('hidden');
        const playerTitle = this.el('player-title');
        const playerPodcast = this.el('player-podcast');
        if (playerTitle) playerTitle.textContent = ep.title;
        if (playerPodcast) playerPodcast.textContent = ep.podcast;
        this.audio.src = ep.audio;
        this.audio.load();
        const pos = ep.position || 0;
        this.audio.addEventListener('loadedmetadata', () => {
            if (pos > 0 && pos < this.audio.duration) {
                this.audio.currentTime = pos;
                const currentTimeEl = this.el('current-time');
                if (currentTimeEl) currentTimeEl.textContent = this.formatTime(pos);
            }
        }, { once: true });
    }

    togglePlaylistBtn() {
        if (!this.currentPlayerEpisode) return;
        const added = this.addToPlaylist(this.currentPlayerEpisode);
        const btn = this.el('playlist-toggle-btn');
        if (btn) {
            btn.classList.add('active');
            setTimeout(() => btn.classList.remove('active'), 1000);
        }
        if (!added) {
            const status = this.el('player-podcast');
            if (status) status.title = 'Already in playlist';
        }
    }

    closePlayer() {
        this.audio.pause();
        const player = this.el('player');
        if (player) player.classList.add('hidden');
        this.currentPlayerEpisode = null;
        this.currentEpisodeId = null;
        storage.set(PLAYER_KEY, null);
    }

    addToPlaylist(episode) {
        if (this.playlist.some(e => e.id === episode.id)) return false;
        this.playlist.push(episode);
        storage.set('podcast_playlist', this.playlist);
        if (this.currentPage === 'details' && this.currentPodcastId) {
            this.showPodcastDetails(this.currentPodcastId);
        } else {
            this.renderPlaylist();
        }
        return true;
    }

    

    async loadSearchResults(query) {
        this.showLoading(true);
        try {
            const seen = new Set();
            let podcasts;
            if (IS_PI) {
                const data = await this.apiFetch(`${CONFIG.PI_BASE_URL}/search/byterm?q=${encodeURIComponent(query)}`);
                podcasts = (data.feeds || [])
                    .filter(f => f && f.id && !seen.has(f.id) && seen.add(f.id))
                    .map(f => this.normFeed(f));
            } else {
                const url = `${CONFIG.BASE_URL}/search?q=${encodeURIComponent(query)}&type=podcast&offset=${this.nextOffset}`;
                const data = await this.apiFetch(url);
                podcasts = (data.results || [])
                    // Search may return podcast objects, or episode objects with a nested podcast
                    .map(r => (r && r.podcast && r.podcast.id) ? r.podcast : r)
                    .filter(p => p && p.id && !seen.has(p.id) && seen.add(p.id))
                    .map(p => ({
                        id: p.id,
                        name: p.title_original || p.title || p.name,
                        publisher: p.publisher_original || p.publisher || p.artist,
                        image: p.image || p.thumbnail,
                        description: p.description_original || p.description,
                    }));
            }
            const grid = this.el('podcast-grid');
            if (grid) grid.innerHTML = '';
            this.renderPodcasts(podcasts);
            this.hasMore = false;
            const searchStatus = this.el('search-status');
            if (searchStatus) {
                searchStatus.textContent = podcasts.length
                    ? `Found ${podcasts.length} podcast${podcasts.length === 1 ? '' : 's'}`
                    : 'No podcasts found';
            }
        } catch (err) {
            console.error('Search failed:', err);
        } finally {
            this.showLoading(false);
        }
    }

    

    handleScroll() {
        if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) {
            const loadingIndicator = this.el('loading-indicator');
            if (loadingIndicator && loadingIndicator.style.display === 'block') return;

            
            if (this.currentPage === 'details' && this.currentPodcastId && this.currentEpisodePubDate) {
                this.loadMoreEpisodes();
            }
            
            else if (this.currentPage === 'landing' && !this.isSearching && this.nextPageNumber) {
                this.loadPodcasts(this.nextPageNumber);
            }
        }
    }

    async loadMoreEpisodes() {
        if (!this.currentPodcastId || !this.currentEpisodePubDate) return;
        this.showLoading(true);
        try {
            const data = await this.loadPodcastEpisodes(this.currentPodcastId, this.currentEpisodePubDate);
            const episodes = data.episodes || [];
            const list = this.el('episodes-list');
            if (!list) return;

            episodes.forEach(ep => {
                const item = document.createElement('div');
                item.className = 'episode-item';
                const isInPlaylist = this.playlist.some(e => e.id === ep.id);
                item.innerHTML = `
                    <div class="episode-header">
                        <h3>${this.escape(ep.title)}</h3>
                        <div class="episode-meta">
                            <span class="episode-date">${this.formatDate(ep.publish_date)}</span>
                            ${ep.duration ? `<span class="episode-duration">${this.formatDuration(ep.duration)}</span>` : ''}
                        </div>
                    </div>
                    <p>${this.escape(ep.description)}</p>
                    <div class="episode-actions">
                        <button class="play-btn" data-id="${ep.id}" data-url="${this.escape(ep.audio)}" data-title="${this.escape(ep.title)}" data-podcast="${this.escape(ep.podcast)}" data-image="${this.escape(this.safeUrl(ep.podcast_image))}">▶ Play</button>
                        <button class="add-btn" data-id="${ep.id}" data-url="${this.escape(ep.audio)}" data-title="${this.escape(ep.title)}" data-podcast="${this.escape(ep.podcast)}" data-image="${this.escape(this.safeUrl(ep.podcast_image))}">${isInPlaylist ? '✓ In List' : '+ Add'}</button>
                    </div>
                `;
                list.appendChild(item);
            });

            
            list.querySelectorAll('.play-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    this.playEpisode(btn.dataset.url, btn.dataset.title, btn.dataset.podcast, btn.dataset.id, btn.dataset.image);
                });
            });

           
            list.querySelectorAll('.add-btn').forEach(btn => {
                if (!btn.dataset.bound) {
                    btn.dataset.bound = 'true';
                    btn.addEventListener('click', () => {
                        this.addToPlaylist({
                            id: btn.dataset.id,
                            title: btn.dataset.title,
                            podcast: btn.dataset.podcast,
                            audio: btn.dataset.url,
                            image: btn.dataset.image,
                        });
                        btn.textContent = '✓ In List';
                        btn.disabled = true;
                    });
                }
            });

            this.currentEpisodePubDate = data.next_episode_pub_date || null;
        } catch (err) {
            console.error('Failed to load more episodes:', err);
        } finally {
            this.showLoading(false);
        }
    }

    async loadPodcasts(page) {
        this.showLoading(true);
        try {
            const data = await this.loadBestPodcasts(page);
            const podcasts = data.podcasts || [];
            if (page === 1 || page === undefined || page === null) {
                const grid = this.el('podcast-grid');
                if (grid) grid.innerHTML = '';
            }
            this.renderPodcasts(podcasts);
            this.nextPageNumber = data.next_page_number || null;
            this.hasMore = !!this.nextPageNumber;
            const searchStatus = this.el('search-status');
            if (searchStatus) searchStatus.textContent = data.total ? `Showing ${data.total} podcasts` : '';
        } catch (err) {
            console.error('Failed to load podcasts:', err);
        } finally {
            this.showLoading(false);
        }
    }

   

    escape(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Returns a raw URL (or an inline placeholder). Callers must escape() it for HTML.
    safeUrl(url) {
        return url || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="%23333"/><text x="50" y="50" text-anchor="middle" dy=".3em" fill="#888" font-size="14">🎙️</text></svg>';
    }

    formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    formatDate(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    formatDuration(seconds) {
        if (!seconds || isNaN(seconds)) return '';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) {
            return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
        return `${m}:${s.toString().padStart(2, '0')}`;
    }
}


const app = new PodcastApp();
