// Copy this file to config.local.js and fill in your own values.
// config.local.js is gitignored so your keys/secret are never committed.

// Which API to use: 'listennotes' (default) or 'podcastindex'
window.__PODCAST_PROVIDER__ = 'listennotes';

// Listen Notes (test API needs no key)
window.__PODCAST_API_KEY__ = '';
window.__PODCAST_BASE_URL__ = 'https://listen-api-test.listennotes.com/api/v2';

// Podcast Index (set these and switch provider to 'podcastindex')
window.__PODCAST_PI_KEY__ = '';
window.__PODCAST_PI_SECRET__ = '';
window.__PODCAST_PI_BASE_URL__ = 'https://api.podcastindex.org/api/1.0';
