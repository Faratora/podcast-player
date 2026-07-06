// ============================================
// Section 1: Landing Page & Search
// ============================================

class PodcastAPI {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://listen-api.listennotes.com/api/v2';
    }

    async request(endpoint, params = {}) {
        const url = new URL(`${this.baseUrl}${endpoint}`);
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                url.searchParams.append(key, value);
            }
        });

        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-ListenAPI-Key': this.apiKey,
            },
        });

        if (!response.ok) {
            throw new Error(`API request failed: ${response.status} ${response.statusText}`);
        }

        return response.json();
    }

    async getBestPodcasts(page = 1) {
        return this.request('/best_podcasts', {
            sort: 'recent_published_first',
            page: page,
        });
    }

    async searchPodcasts(query, offset = 0) {
        return this.request('/search', {
            q: query,
            type: 'podcast',
            offset: offset,
        });
    }
}

class App {
    constructor() {
        this.api = new PodcastAPI(window.__PODCAST_API_KEY__);
        this.currentPodcasts = [];
        this.isLoading = false;
        this.currentPage = 1;
        this.currentSearchQuery = '';
        this.currentSearchOffset = 0;
        this.debounceTimer = null;
        this.isSearchMode = false;

        this.init();
    }

    init() {
        this.cacheDOM();
        this.bindEvents();
        this.loadInitialPodcasts();
    }

    cacheDOM() {
        this.landingPage = document.getElementById('landing-page');
        this.searchInput = document.getElementById('search-input');
        this.searchStatus = document.getElementById('search-status');
        this.podcastGrid = document.getElementById('podcast-grid');
        this.loadingIndicator = document.getElementById('loading-indicator');
        this.navHome = document.getElementById('nav-home');
    }

    bindEvents() {
        this.searchInput.addEventListener('input', (e) => {
            this.handleSearchInput(e.target.value);
        });

        this.navHome.addEventListener('click', () => {
            this.showLandingPage();
        });
    }

    async loadInitialPodcasts() {
        this.currentPage = 1;
        this.isSearchMode = false;
        this.currentPodcasts = [];
        await this.loadPodcasts();
    }

    async loadPodcasts() {
        if (this.isLoading) return;
        this.isLoading = true;
        this.loadingIndicator.style.display = 'block';

        try {
            let result;
            if (this.isSearchMode && this.currentSearchQuery) {
                result = await this.api.searchPodcasts(
                    this.currentSearchQuery,
                    this.currentSearchOffset
                );
            } else {
                result = await this.api.getBestPodcasts(this.currentPage);
            }

            this.renderPodcasts(result);
            this.updatePagination(result);
        } catch (error) {
            console.error('Error loading podcasts:', error);
            this.searchStatus.textContent = 'Error loading podcasts. Please try again.';
        } finally {
            this.isLoading = false;
            this.loadingIndicator.style.display = 'none';
        }
    }

    renderPodcasts(result) {
        const podcasts = result.podcasts || [];
        
        if (this.currentPodcasts.length === 0 && podcasts.length === 0) {
            this.podcastGrid.innerHTML = '<p style="text-align: center; color: #b3b3b3; grid-column: 1/-1;">No podcasts found.</p>';
            return;
        }

        this.currentPodcasts = [...this.currentPodcasts, ...podcasts];
        
        this.podcastGrid.innerHTML = this.currentPodcasts
            .map((podcast) => this.createPodcastCard(podcast))
            .join('');

        document.querySelectorAll('.podcast-card').forEach((card) => {
            card.addEventListener('click', () => {
                const podcastId = card.dataset.id;
                const podcast = this.currentPodcasts.find((p) => p.id === podcastId);
                if (podcast) {
                    
                    if (window.appDetails) {
                        window.appDetails.loadPodcastDetails(podcast.id);
                    }
                }
            });
        });
    }

    
    createPodcastCard(podcast) {
        const image = podcast.image || '';
        const title = podcast.title_original || 'Untitled';
        const publisher = podcast.publisher_original || 'Unknown';

        return `
            <div class="podcast-card" data-id="${podcast.id}">
                <img src="${image}" alt="${title}" loading="lazy" />
                <h3>${this.escapeHtml(title)}</h3>
                <p>${this.escapeHtml(publisher)}</p>
            </div>
        `;
    }

    updatePagination(result) {
        if (this.isSearchMode) {
            this.currentSearchOffset = result.next_offset || 0;
            const totalResults = result.meta.total || 0;
            const currentCount = this.currentPodcasts.length;
            if (currentCount > 0 && this.currentSearchOffset > 0) {
                this.searchStatus.textContent = `Showing ${currentCount} of ${totalResults} results`;
            }
        } else {
            this.currentPage = result.next_page_number || 0;
            const totalResults = result.meta.total || 0;
            const currentCount = this.currentPodcasts.length;
            if (currentCount > 0 && this.currentPage > 0) {
                this.searchStatus.textContent = `Showing ${currentCount} of ${totalResults} podcasts`;
            }
        }
    }

    handleSearchInput(query) {
        
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        if (!query || query.trim() === '') {
            this.searchStatus.textContent = '';
            this.loadInitialPodcasts();
            return;
        }

        this.debounceTimer = setTimeout(async () => {
            this.isSearchMode = true;
            this.currentSearchQuery = query.trim();
            this.currentPodcasts = [];
            this.currentSearchOffset = 0;
            this.searchStatus.textContent = `Searching for "${this.currentSearchQuery}"...`;
            await this.loadPodcasts();
            this.searchStatus.textContent = '';
        }, 500);
    }

    showLandingPage() {
        this.searchInput.value = '';
        this.searchStatus.textContent = '';
        this.isSearchMode = false;
        this.currentSearchQuery = '';
        this.currentPodcasts = [];
        this.currentPage = 1;
        this.loadInitialPodcasts();
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});