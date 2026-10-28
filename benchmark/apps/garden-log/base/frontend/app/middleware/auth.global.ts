const PUBLIC_ROUTES = new Set(['/login'])

export default defineNuxtRouteMiddleware(async (to) => {
  const user = useCurrentUser()
  if (!user.value) {
    user.value = await loadCurrentUser()
  }

  if (PUBLIC_ROUTES.has(to.path)) {
    if (user.value) return navigateTo('/')
    return
  }

  if (!user.value) {
    const query = to.fullPath === '/' ? {} : { redirect: to.fullPath }
    return navigateTo({ path: '/login', query })
  }
})
