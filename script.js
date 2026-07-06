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
}

class PodcastAPI {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.cache = new Map();
        this.cacheTTL = 5 * 60 * 1000;
    }
}