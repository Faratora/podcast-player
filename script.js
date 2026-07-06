const CONFIG = {
    API_KEY: window.__PODCAST_API_KEY__ || (() => {
        alert('API key not configured...');
        return '';
    })(),
    BASE_URL: 'https://listen-api-test.listennotes.com/api/v2',
    DEBOUNCE_DELAY: 300,
    RESUME_OFFSET: 10,
};