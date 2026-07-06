const CONFIG = {
    API_KEY: window.__PODCAST_API_KEY__ || (() => {
        alert('API key not configured...');
        return '';
    })(),
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