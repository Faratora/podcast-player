const CONFIG = {
    API_KEY: window.__PODCAST_API_KEY__ || '',
    BASE_URL: 'https://listen-api.listennotes.com/api/v2',
    DEBOUNCE_DELAY: 300,
    RESUME_OFFSET: 10,
};

const PROGRESS_KEY = 'podcast_progress';

class PodcastApp {
    constructor() {
        this.currentPage = 'landing';
        this.searchQuery = '';
        this.currentPodcastId = null;
        this.currentEpisodePubDate = null;
        this.playlist = JSON.parse(localStorage.getItem('podcast_playlist') || '[]');
        this.audio = new Audio();
        this.audio.preload = 'metadata';
        this.currentPageNum = 0;
        this.nextPageNumber = 1;
        this.nextOffset = 0;
        this.hasMore = true;
        this.isSearching = false;
        this.searchTimeout = null;
        this.currentEpisodeId = null;

        this.cache = new Map();
        this.cacheTTL = 5 * 60 * 1000;

        this.init();
    }

    // --- API ---

    async apiFetch(url) {
        const cached = this.cache.get(url);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
            return cached.data;
        }
        const res = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'X-ListenAPI-Key': CONFIG.API_KEY,
            },
        });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const data = await res.json();
        this.cache.set(url, { data, timestamp: Date.now() });
        return data;
    }

    async loadBestPodcasts(page) {
        const url = `${CONFIG.BASE_URL}/best_podcasts?sort=recent_published_first&page=${page}`;
        return this.apiFetch(url);
    }

    async loadPodcastEpisodes(id, pubDate) {
        let url = `${CONFIG.BASE_URL}/podcasts/${id}`;
        if (pubDate) {
            url += `?next_episode_pub_date=${pubDate}`;
        }
        return this.apiFetch(url);
    }

    // --- DOM ---

    el(id) {
        return document.getElementById(id);
    }

    init() {
        this.bindEvents();
        this.renderPlaylist();
        this.loadPodcasts();
        this.setupAudio();
    }

    bindEvents() {
        // Search
        this.el('search-input').addEventListener('input', (e) => {
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
                    this.el('podcast-grid').innerHTML = '';
                    this.loadSearchResults(q);
                } else {
                    this.isSearching = false;
                    this.currentPageNum = 0;
                    this.nextPageNumber = 1;
                    this.nextOffset = 0;
                    this.searchQuery = '';
                    this.hasMore = true;
                    this.el('podcast-grid').innerHTML = '';
                    this.loadPodcasts();
                }
            }, CONFIG.DEBOUNCE_DELAY);
        });

        // Nav
        this.el('nav-home').addEventListener('click', () => this.navigateTo('landing'));
        this.el('nav-playlist').addEventListener('click', () => this.navigateTo('playlist'));
        this.el('back-button').addEventListener('click', () => this.navigateTo('landing'));

        // Player controls
        this.el('play-pause-btn').addEventListener('click', () => this.togglePlay());
        this.el('rewind-btn').addEventListener('click', () => this.seek(-15));
        this.el('forward-btn').addEventListener('click', () => this.seek(15));
        this.el('progress-bar').addEventListener('click', (e) => {
            const rect = this.el('progress-bar').getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            this.audio.currentTime = pct * this.audio.duration;
        });
        this.el('playlist-toggle-btn').addEventListener('click', () => this.togglePlaylistBtn());

        // Scroll
        window.addEventListener('scroll', () => this.handleScroll());

        // Keyboard
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Space' && !e.target.matches('input, textarea')) {
                e.preventDefault();
                this.togglePlay();
            }
        });
    }

    setupAudio() {
        this.audio.addEventListener('timeupdate', () => {
            if (this.audio.duration) {
                const pct = (this.audio.currentTime / this.audio.duration) * 100;
                this.el('progress-fill').style.width = `${pct}%`;
                this.el('current-time').textContent = this.formatTime(this.audio.currentTime);

                // Save playback position for current episode
                if (this.currentEpisodeId && this.audio.currentTime > 5) {
                    this.saveProgress(this.currentEpisodeId, this.audio.currentTime);
                }
            }
        });

        this.audio.addEventListener('loadedmetadata', () => {
            this.el('total-time').textContent = this.formatTime(this.audio.duration);
        });

        this.audio.addEventListener('play', () => {
            this.el('play-pause-btn').textContent = '⏸';
        });

        this.audio.addEventListener('pause', () => {
            this.el('play-pause-btn').textContent = '▶';
        });

        this.audio.addEventListener('ended', () => {
            this.el('play-pause-btn').textContent = '▶';
            this.el('progress-fill').style.width = '0%';
            this.currentEpisodeId = null;
        });
    }

    // --- Navigation ---

    navigateTo(page) {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        this.el(`${page}-page`).classList.add('active');
        this.currentPage = page;
        this.currentPodcastId = null;
        this.currentEpisodePubDate = null;
    }

    // --- Rendering ---

    showLoading(show) {
        this.el('loading-indicator').style.display = show ? 'block' : 'none';
    }

    renderPodcasts(podcasts) {
        const grid = this.el('podcast-grid');
        podcasts.forEach(podcast => {
            const card = document.createElement('div');
            card.className = 'podcast-card';
            card.innerHTML = `
                <img src="${this.safeUrl(podcast.image)}" alt="${this.escape(podcast.name)}" />
                <h3>${this.escape(podcast.name)}</h3>
                <p>${this.escape(podcast.description)}</p>
                <button class="detail-btn" data-id="${podcast.id}">View Episodes</button>
            `;
            card.querySelector('.detail-btn').addEventListener('click', () => this.showPodcastDetails(podcast.id));
            grid.appendChild(card);
        });
    }

    async showPodcastDetails(id) {
        this.navigateTo('details');
        this.currentPodcastId = id;
        this.currentEpisodePubDate = null;
        this.showLoading(true);

        try {
            const data = await this.loadPodcastEpisodes(id);
            const episodes = data.episodes || [];

            // Podcast info
            const podcast = data.podcast || {};
            if (podcast.name) {
                this.el('podcast-details').innerHTML = `
                    <div class="podcast-hero">
                        <img src="${this.safeUrl(podcast.image)}" alt="${this.escape(podcast.name)}" />
                        <div class="podcast-hero-info">
                            <h2>${this.escape(podcast.name)}</h2>
                            <p>${this.escape(podcast.description)}</p>
                        </div>
                    </div>
                `;
            }

            // Episodes
            const list = this.el('episodes-list');
            list.innerHTML = '';
            episodes.forEach(ep => {
                const item = document.createElement('div');
                item.className = 'episode-item';
                const isInPlaylist = this.playlist.some(e => e.id === ep.id);
                item.innerHTML = `
                    <div class="episode-header">
                        <h3>${this.escape(ep.title)}</h3>
                        <span class="episode-date">${this.formatDate(ep.publish_date)}</span>
                    </div>
                    <p>${this.escape(ep.description)}</p>
                    <div class="episode-actions">
                        <button class="play-btn" data-id="${ep.id}" data-url="${ep.audio}" data-title="${this.escape(ep.title)}" data-podcast="${this.escape(ep.podcast)}">▶ Play</button>
                        <button class="add-btn" data-id="${ep.id}" data-url="${ep.audio}" data-title="${this.escape(ep.title)}" data-podcast="${this.escape(ep.podcast)}" data-image="${this.safeUrl(ep.podcast_image)}">${isInPlaylist ? '✓ In List' : '+ Add'}</button>
                    </div>
                `;
                list.appendChild(item);
            });

            // Bind play buttons
            list.querySelectorAll('.play-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    this.playEpisode(btn.dataset.url, btn.dataset.title, btn.dataset.podcast, btn.dataset.id);
                });
            });

            // Bind add buttons
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

            // Store next_episode_pub_date for pagination
            this.currentEpisodePubDate = data.next_episode_pub_date || null;
        } catch (err) {
            console.error(err);
            this.el('podcast-details').innerHTML = '<p style="color:#ff4444">Failed to load podcast details.</p>';
        } finally {
            this.showLoading(false);
        }
    }

    renderPlaylist() {
        const container = this.el('playlist-items');
        const empty = this.el('playlist-empty');
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
                    <button class="play-btn" data-id="${ep.id}" data-url="${ep.audio}" data-title="${this.escape(ep.title)}" data-podcast="${this.escape(ep.podcast)}">▶</button>
                    <button class="remove-btn" data-idx="${idx}">✕</button>
                </div>
            `;
            container.appendChild(item);
        });

        container.querySelectorAll('.play-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.playEpisode(btn.dataset.url, btn.dataset.title, btn.dataset.podcast, btn.dataset.id);
            });
        });

        container.querySelectorAll('.remove-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.playlist.splice(parseInt(btn.dataset.idx), 1);
                localStorage.setItem('podcast_playlist', JSON.stringify(this.playlist));
                this.renderPlaylist();
            });
        });
    }

    // --- Playback ---

    playEpisode(url, title, podcast, episodeId) {
        this.audio.src = url;
        this.audio.play();
        this.el('player-title').textContent = title;
        this.el('player-podcast').textContent = podcast;
        this.currentEpisodeId = episodeId;

        // Restore saved position with 10s offset
        const saved = this.getProgress(episodeId);
        if (saved > 5) {
            this.audio.currentTime = Math.max(0, saved - CONFIG.RESUME_OFFSET);
        }
    }

    togglePlay() {
        if (this.audio.paused) {
            this.audio.play();
        } else {
            this.audio.pause();
        }
    }

    seek(seconds) {
        this.audio.currentTime = Math.max(0, this.audio.currentTime + seconds);
    }

    // --- Progress ---

    getProgress(episodeId) {
        const data = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
        return data[episodeId] || 0;
    }

    saveProgress(episodeId, position) {
        const data = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
        data[episodeId] = position;
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(data));
    }

    togglePlaylistBtn() {
        // Simplified: no state.currentEpisode in this version
    }

    addToPlaylist(episode) {
        if (!this.playlist.some(e => e.id === episode.id)) {
            this.playlist.push(episode);
            localStorage.setItem('podcast_playlist', JSON.stringify(this.playlist));
        }
    }

    // --- Search ---

    async loadSearchResults(query) {
        this.showLoading(true);
        try {
            const url = `${CONFIG.BASE_URL}/search?q=${encodeURIComponent(query)}&type=podcast&offset=${this.nextOffset}`;
            const data = await this.apiFetch(url);
            const podcasts = data.results?.filter(r => r.type === 'podcast') || [];
            if (this.nextOffset === 0) {
                this.el('podcast-grid').innerHTML = '';
            }
            this.renderPodcasts(podcasts);
            this.nextOffset = data.next_offset || 0;
            this.hasMore = data.has_next;
            this.el('search-status').textContent = data.total ? `Found ${data.total} podcasts` : '';
        } catch (err) {
            console.error('Search failed:', err);
        } finally {
            this.showLoading(false);
        }
    }

    // --- Infinite Scroll ---

    handleScroll() {
        if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) {
            if (this.el('loading-indicator').style.display === 'block') return;

            // Episode pagination on details page
            if (this.currentPage === 'details' && this.currentPodcastId && this.currentEpisodePubDate) {
                this.loadMoreEpisodes();
            }
            // Podcast pagination on landing page
            else if (this.currentPage === 'landing' && !this.isSearching && this.nextPageNumber) {
                this.loadPodcasts(this.nextPageNumber);
            }
            // Search pagination
            else if (this.isSearching && this.hasMore) {
                this.nextOffset += 10;
                this.loadSearchResults(this.searchQuery);
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

            episodes.forEach(ep => {
                const item = document.createElement('div');
                item.className = 'episode-item';
                const isInPlaylist = this.playlist.some(e => e.id === ep.id);
                item.innerHTML = `
                    <div class="episode-header">
                        <h3>${this.escape(ep.title)}</h3>
                        <span class="episode-date">${this.formatDate(ep.publish_date)}</span>
                    </div>
                    <p>${this.escape(ep.description)}</p>
                    <div class="episode-actions">
                        <button class="play-btn" data-id="${ep.id}" data-url="${ep.audio}" data-title="${this.escape(ep.title)}" data-podcast="${this.escape(ep.podcast)}">▶ Play</button>
                        <button class="add-btn" data-id="${ep.id}" data-url="${ep.audio}" data-title="${this.escape(ep.title)}" data-podcast="${this.escape(ep.podcast)}" data-image="${this.safeUrl(ep.podcast_image)}">${isInPlaylist ? '✓ In List' : '+ Add'}</button>
                    </div>
                `;
                list.appendChild(item);
            });

            // Bind new play buttons
            list.querySelectorAll('.play-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    this.playEpisode(btn.dataset.url, btn.dataset.title, btn.dataset.podcast, btn.dataset.id);
                });
            });

            // Bind new add buttons
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
            if (page === 1) {
                this.el('podcast-grid').innerHTML = '';
            }
            this.renderPodcasts(podcasts);
            this.nextPageNumber = data.next_page_number || null;
            this.hasMore = !!this.nextPageNumber;
            this.el('search-status').textContent = data.total ? `Showing ${data.total} podcasts` : '';
        } catch (err) {
            console.error('Failed to load podcasts:', err);
        } finally {
            this.showLoading(false);
        }
    }

    // --- Helpers ---

    escape(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

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
}

// --- Init ---
const app = new PodcastApp();
