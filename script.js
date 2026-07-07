const CONFIG = {
    API_KEY: window.__PODCAST_API_KEY__ || '',
    BASE_URL: 'https://listen-api-test.listennotes.com/api/v2',
    DEBOUNCE_DELAY: 300,
    RESUME_OFFSET: 10,
};

class AppState {
    constructor() {
        this.currentPage = 'landing';
        this.currentPodcastId = null;
        this.currentEpisode = null;
        this.playlist = this.loadPlaylist();
        this.playbackProgress = this.loadProgress();
        this.currentEpisodeId = this.loadCurrentEpisodeId();
        this.searchQuery = '';
        this.pagination = {
            landing: { page: 1, hasMore: true },
            search: { offset: 0, hasMore: true },
        };
        this.isLoading = false;
        this.audioPlayer = new Audio();
        this.audioPlayer.preload = 'metadata';
    }

    loadPlaylist() {
        try {
            const data = localStorage.getItem('podcast_playlist');
            return data ? JSON.parse(data) : [];
        } catch {
            return [];
        }
    }

    savePlaylist() {
        localStorage.setItem('podcast_playlist', JSON.stringify(this.playlist));
    }

    loadProgress() {
        try {
            const data = localStorage.getItem('podcast_progress');
            return data ? JSON.parse(data) : {};
        } catch {
            return {};
        }
    }

    saveProgress(episodeId, position) {
        this.playbackProgress[episodeId] = position;
        localStorage.setItem('podcast_progress', JSON.stringify(this.playbackProgress));
    }

    loadCurrentEpisodeId() {
        try {
            return localStorage.getItem('podcast_current_episode_id') || null;
        } catch {
            return null;
        }
    }

    saveCurrentEpisodeId(episodeId) {
        localStorage.setItem('podcast_current_episode_id', episodeId);
    }

    addToPlaylist(episode) {
        if (!this.playlist.find(e => e.id === episode.id)) {
            this.playlist.push(episode);
            this.savePlaylist();
            return true;
        }
        return false;
    }

    removeFromPlaylist(episodeId) {
        this.playlist = this.playlist.filter(e => e.id !== episodeId);
        this.savePlaylist();
    }

    isInPlaylist(episodeId) {
        return this.playlist.some(e => e.id === episodeId);
    }

    getProgress(episodeId) {
        return this.playbackProgress[episodeId] || 0;
    }
}

class PodcastAPI {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.cache = new Map();
        this.cacheTTL = 5 * 60 * 1000;
    }

    async fetch(url, retries = 3) {
        const cached = this.cache.get(url);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
            return cached.data;
        }

        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(url, {
                    headers: {
                        'Accept': 'application/json',
                        'X-ListenAPI-Key': this.apiKey,
                    },
                });

                if (response.status === 429) {
                    const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
                    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                    continue;
                }

                if (!response.ok) {
                    throw new Error(`API request failed: ${response.status}`);
                }

                const data = await response.json();
                this.cache.set(url, { data, timestamp: Date.now() });
                return data;
            } catch (error) {
                if (i === retries - 1) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            }
        }
    }

    async getBestPodcasts(page = 1) {
        const url = `${CONFIG.BASE_URL}/best_podcasts?sort=recent_published_first&page=${page}`;
        return this.fetch(url);
    }

    async searchPodcasts(query, offset = 0) {
        const encodedQuery = encodeURIComponent(query);
        const url = `${CONFIG.BASE_URL}/search?q=${encodedQuery}&type=podcast&offset=${offset}`;
        return this.fetch(url);
    }

    async getPodcastDetails(id) {
        const url = `${CONFIG.BASE_URL}/podcasts/${id}`;
        return this.fetch(url);
    }

    async getPodcastEpisodes(id, offset = 0) {
        const url = `${CONFIG.BASE_URL}/podcasts/${id}/episodes?offset=${offset}&sort_by_pub_date=asc`;
        return this.fetch(url);
    }
}


class PodcastApp {
    constructor() {
        this.state = new AppState();
        this.api = new PodcastAPI(CONFIG.API_KEY);
        this.searchTimeout = null;
        this.isPlaying = false;
        this.init();
    }

    init() {
        this.elements = {
            landingPage: document.getElementById('landing-page'),
            detailsPage: document.getElementById('details-page'),
            playlistPage: document.getElementById('playlist-page'),
            podcastGrid: document.getElementById('podcast-grid'),
            detailsContainer: document.getElementById('podcast-details'),
            episodesList: document.getElementById('episodes-list'),
            searchInput: document.getElementById('search-input'),
            searchStatus: document.getElementById('search-status'),
            loadingIndicator: document.getElementById('loading-indicator'),
            backButton: document.getElementById('back-button'),
            navHome: document.getElementById('nav-home'),
            navPlaylist: document.getElementById('nav-playlist'),
            player: document.getElementById('player'),
            playerTitle: document.getElementById('player-title'),
            playerPodcast: document.getElementById('player-podcast'),
            playPauseBtn: document.getElementById('play-pause-btn'),
            rewindBtn: document.getElementById('rewind-btn'),
            forwardBtn: document.getElementById('forward-btn'),
            progressFill: document.getElementById('progress-fill'),
            progressBar: document.getElementById('progress-bar'),
            currentTime: document.getElementById('current-time'),
            totalTime: document.getElementById('total-time'),
            playlistToggleBtn: document.getElementById('playlist-toggle-btn'),
            playlistItems: document.getElementById('playlist-items'),
            playlistEmpty: document.getElementById('playlist-empty'),
        };
        
        this.setupEventListeners();
        this.loadLandingPage();
        this.restorePlaybackState();
        this.setupAudioPlayer();
    }

    setupEventListeners() {
    
    this.elements.searchInput.addEventListener('input', (e) => {
        clearTimeout(this.searchTimeout);
        const query = e.target.value.trim();
        this.state.searchQuery = query;

        this.searchTimeout = setTimeout(() => {
            if (query) {
                this.navigateTo('landing');
                this.performSearch(query);
            } else {
                this.state.currentPage = 'landing';
                this.loadLandingPage();
            }
        }, CONFIG.DEBOUNCE_DELAY);
    });

    
    this.elements.navHome.addEventListener('click', () => this.navigateTo('landing'));
    this.elements.navPlaylist.addEventListener('click', () => this.navigateTo('playlist'));
    this.elements.backButton.addEventListener('click', () => this.navigateTo('landing'));

    
    this.elements.playPauseBtn.addEventListener('click', () => this.togglePlayback());
    this.elements.rewindBtn.addEventListener('click', () => this.seekRelative(-15));
    this.elements.forwardBtn.addEventListener('click', () => this.seekRelative(15));

    
    this.elements.progressBar.addEventListener('click', (e) => {
        const rect = this.elements.progressBar.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percentage = x / rect.width;
        const duration = this.state.audioPlayer.duration;
        if (duration) {
            this.state.audioPlayer.currentTime = percentage * duration;
        }
    });

    this.elements.playlistToggleBtn.addEventListener('click', () => {
        if (this.state.currentEpisode) {
            this.togglePlaylist();
        }
    });

    window.addEventListener('scroll', () => this.handleScroll());

    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && !e.target.matches('input, textarea')) {
            e.preventDefault();
            this.togglePlayback();
        }
    });
}

setupAudioPlayer() {
    const audio = this.state.audioPlayer;

    
    audio.addEventListener('timeupdate', () => {
        if (audio.duration && !isNaN(audio.duration)) {
            const progress = (audio.currentTime / audio.duration) * 100;
            this.elements.progressFill.style.width = `${progress}%`;
            this.elements.currentTime.textContent = this.formatTime(audio.currentTime);
            
            if (this.state.currentEpisode && audio.currentTime > 0) {
                this.state.saveProgress(this.state.currentEpisode.id, audio.currentTime);
            }
        }
    });

    
    audio.addEventListener('loadedmetadata', () => {
        this.elements.totalTime.textContent = this.formatTime(audio.duration);
        
        if (this.state.currentEpisode) {
            const savedProgress = this.state.getProgress(this.state.currentEpisode.id);
            if (savedProgress > 0) {
                const resumeTime = Math.max(0, savedProgress - CONFIG.RESUME_OFFSET);
                audio.currentTime = resumeTime;
            }
        }
    });

    
    audio.addEventListener('play', () => {
        this.isPlaying = true;
        this.elements.playPauseBtn.textContent = '⏸';
    });

    audio.addEventListener('pause', () => {
        this.isPlaying = false;
        this.elements.playPauseBtn.textContent = '▶';
    });

    
    audio.addEventListener('ended', () => {
        this.isPlaying = false;
        this.elements.playPauseBtn.textContent = '▶';
        this.elements.progressFill.style.width = '0%';
        this.elements.currentTime.textContent = '0:00';
        this.state.saveCurrentEpisodeId(null);
    });
}

async loadLandingPage(append = false) {
    this.showLoading();

    if (!append) {
        this.state.pagination.landing.page = 1;
        this.state.pagination.landing.hasMore = true;
        this.elements.podcastGrid.innerHTML = '';
        this.api.cache.clear();
    }

    try {
        const page = this.state.pagination.landing.page;
        const data = await this.api.getBestPodcasts(page);
        const podcasts = data.podcasts || [];

        if (append) {
            this.appendPodcasts(podcasts);
        } else {
            this.renderPodcasts(podcasts);
        }

        this.state.pagination.landing.hasMore = data.has_next || false;
        this.state.pagination.landing.page = page + 1;
        this.elements.searchStatus.textContent = data.total ? `Showing ${data.total} podcasts` : '';
    } catch (error) {
        console.error('Failed to load podcasts:', error);
        if (!append) {
            this.elements.podcastGrid.innerHTML = '<p style="color: #ff4444;">Failed to load podcasts.</p>';
        }
    } finally {
        this.hideLoading();
    }
}

async performSearch(query, reset = true) {
    this.showLoading();
    
    if (reset) {
        this.state.pagination.search.offset = 0;
        this.state.pagination.search.hasMore = true;
        this.elements.podcastGrid.innerHTML = '';
        this.api.cache.clear();
    }

    try {
        const data = await this.api.searchPodcasts(query, this.state.pagination.search.offset);
        const podcasts = data.results || [];
        
        if (reset) {
            this.renderPodcasts(podcasts);
        } else {
            this.appendPodcasts(podcasts);
        }

        this.state.pagination.search.hasMore = data.has_next || false;
        this.state.pagination.search.offset = data.next_offset || 0;
        this.elements.searchStatus.textContent = data.total ? `Found ${data.total} podcasts` : 'No results found';
    } catch (error) {
        console.error('Search failed:', error);
        this.elements.podcastGrid.innerHTML = '<p>Search failed.</p>';
    } finally {
        this.hideLoading();
    }
}

async loadPodcastDetails(id) {
    this.showLoading();
    try {
        const [podcastData, episodesData] = await Promise.all([
            this.api.getPodcastDetails(id),
            this.api.getPodcastEpisodes(id),
        ]);
        this.state.currentPodcastId = id;
        this.renderDetails({ ...podcastData, episodes: episodesData.episodes || [] });
    } catch (error) {
        console.error('Failed to load podcast details:', error);
        this.elements.detailsContainer.innerHTML = '<p>Failed to load podcast details.</p>';
    } finally {
        this.hideLoading();
    }
}

renderDetails(podcast) {
    
    this.elements.detailsContainer.innerHTML = `
        <img src="${podcast.image || podcast.thumbnail || 'https://via.placeholder.com/200'}" 
             alt="${podcast.title || 'Podcast'}" />
        <div class="podcast-info">
            <h2>${podcast.title || 'Untitled'}</h2>
            <p class="author">${podcast.publisher || 'Unknown Author'}</p>
            <p>${podcast.description || 'No description available.'}</p>
            ${podcast.website ? `<p><a href="${podcast.website}" target="_blank">Visit Website</a></p>` : ''}
        </div>
    `;

    
    const episodes = podcast.episodes || [];
    this.elements.episodesList.innerHTML = episodes.map(episode => `
        <div class="episode-item" data-id="${episode.id}">
            <div class="episode-info">
                <h4>${episode.title || episode.title_original || 'Untitled Episode'}</h4>
                <div class="episode-meta">
                    <span>${this.formatDate(episode.pub_date)}</span>
                    <span>${this.formatDuration(episode.duration)}</span>
                    ${this.state.isInPlaylist(episode.id) ? '<span>📋 In Playlist</span>' : ''}
                </div>
            </div>
            <span class="play-icon">▶</span>
        </div>
    `).join('');

    
    this.elements.episodesList.querySelectorAll('.episode-item').forEach(item => {
        item.addEventListener('click', () => {
            const id = item.dataset.id;
            const episode = episodes.find(e => e.id === id);
            if (episode) {
                this.playEpisode(episode, podcast);
            }
        });
    });
}

playEpisode(episode, podcast) {
    if (!episode.audio) {
        alert('This episode has no audio available.');
        return;
    }

    const audio = this.state.audioPlayer;
    const oldEpisode = this.state.currentEpisode;

    
    if (oldEpisode && oldEpisode.id === episode.id) {
        this.togglePlayback();
        return;
    }

    
    if (oldEpisode && audio.currentTime > 0) {
        this.state.saveProgress(oldEpisode.id, audio.currentTime);
    }

    
    this.state.currentEpisode = episode;
    this.state.saveCurrentEpisodeId(episode.id);
    
    audio.pause();
    audio.src = episode.audio;
    
    
    this.elements.player.classList.remove('hidden');
    this.elements.playerTitle.textContent = episode.title || 'Untitled Episode';
    this.elements.playerPodcast.textContent = podcast.title || 'Podcast';
    this.updatePlaylistToggle();

    
    const savedProgress = this.state.getProgress(episode.id);
    if (savedProgress > 0) {
        const resumeTime = Math.max(0, savedProgress - CONFIG.RESUME_OFFSET);
        audio.currentTime = resumeTime;
    }

    audio.load();
    audio.play().catch(err => {
        console.warn('Autoplay prevented:', err);
        this.elements.playPauseBtn.textContent = '▶';
        this.isPlaying = false;
    });
}

togglePlaylist() {
    if (!this.state.currentEpisode) return;

    const episode = this.state.currentEpisode;
    if (this.state.isInPlaylist(episode.id)) {
        this.state.removeFromPlaylist(episode.id);
    } else {
        const playlistEpisode = {
            id: episode.id,
            title: episode.title || 'Untitled Episode',
            duration: episode.duration || 0,
            podcast_title: this.elements.playerPodcast.textContent || 'Podcast',
            audio: episode.audio || ''
        };
        this.state.addToPlaylist(playlistEpisode);
    }
    this.updatePlaylistToggle();
    this.updatePlaylistView();
}

updatePlaylistView() {
    const playlist = this.state.playlist;
    const container = this.elements.playlistItems;
    const empty = this.elements.playlistEmpty;

    if (playlist.length === 0) {
        container.innerHTML = '';
        empty.style.display = 'block';
        return;
    }

    empty.style.display = 'none';
    container.innerHTML = playlist.map(episode => `
        <div class="playlist-item" data-id="${episode.id}">
            <div class="episode-info">
                <h4>${episode.title || 'Untitled Episode'}</h4>
                <div class="episode-meta">
                    <span>${episode.podcast_title || 'Podcast'}</span>
                    <span>${this.formatDuration(episode.duration)}</span>
                </div>
            </div>
            <button class="remove-btn" data-id="${episode.id}">×</button>
        </div>
    `).join('');

    
    container.querySelectorAll('.playlist-item .episode-info').forEach((info, index) => {
        info.addEventListener('click', () => {
            const episode = playlist[index];
            if (episode) {
                this.playEpisode(episode, { title: episode.podcast_title || 'Podcast' });
            }
        });
    });

    container.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            this.state.removeFromPlaylist(id);
            this.updatePlaylistView();
            this.updatePlaylistToggle();
        });
    });
}