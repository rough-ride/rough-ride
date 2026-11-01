export default defineNuxtRouteMiddleware((to) => {
  const token = useCookie<string | null>('token')
  if (!token.value && to.path !== '/login') return navigateTo('/login')
  if (token.value && to.path === '/login') return navigateTo('/notes')
})
