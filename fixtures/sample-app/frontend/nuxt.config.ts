export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: false },
  telemetry: false,
  runtimeConfig: {
    // The Nuxt server calls FastAPI directly during server-side rendering.
    apiBaseServer: 'http://127.0.0.1:8731/api',
    public: {
      // The browser calls FastAPI cross-origin, like the real target apps.
      apiBase: 'http://localhost:8731/api',
      // Planted bugs: "all", "none", or a comma list. Set with NUXT_PUBLIC_BUGS.
      bugs: 'all',
    },
  },
})
