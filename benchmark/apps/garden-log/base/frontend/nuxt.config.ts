export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      titleTemplate: '%s · Garden Log',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'A personal garden journal.' },
      ],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },
  runtimeConfig: {
    // Server-side rendering talks to the API over loopback.
    apiBaseServer: 'http://127.0.0.1:8701/api',
    public: {
      apiBase: 'http://localhost:8701/api',
    },
  },
})
