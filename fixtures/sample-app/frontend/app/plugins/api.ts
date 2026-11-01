export default defineNuxtPlugin((nuxtApp) => {
  const config = useRuntimeConfig()
  const token = useCookie<string | null>('token')

  const api = $fetch.create({
    baseURL: import.meta.server ? config.apiBaseServer : config.public.apiBase,
    onRequest({ options }) {
      if (token.value) options.headers.set('Authorization', `Bearer ${token.value}`)
    },
    async onResponseError({ request, response }) {
      if (response.status === 401 && !String(request).endsWith('/login')) {
        token.value = null
        await nuxtApp.runWithContext(() => navigateTo('/login'))
      }
    },
  })

  return { provide: { api } }
})
