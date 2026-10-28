<script setup lang="ts">
const { user, signOut } = useAuth()
const signingOut = ref(false)
const menuOpen = ref(false)
const route = useRoute()

const links = [
  { to: '/', label: 'Dashboard', exact: true },
  { to: '/plants', label: 'Plants', exact: false },
  { to: '/harvests/new', label: 'Log harvest', exact: true },
  { to: '/tasks', label: 'Tasks', exact: true },
  { to: '/beds', label: 'Beds', exact: true },
]

function isActive(link: { to: string; exact: boolean }): boolean {
  if (link.exact) return route.path === link.to
  return route.path === link.to || (route.path.startsWith(`${link.to}/`) && route.path !== '/plants/new')
}

watch(() => route.fullPath, () => {
  menuOpen.value = false
})

async function handleSignOut(): Promise<void> {
  signingOut.value = true
  try {
    await signOut()
  } finally {
    signingOut.value = false
  }
}
</script>

<template>
  <div class="shell">
    <a class="skip-link" href="#main">Skip to content</a>
    <header class="topbar">
      <div class="topbar__inner">
        <NuxtLink to="/" class="brand">
          <img src="/favicon.svg" alt="" width="28" height="28">
          <span>Garden Log</span>
        </NuxtLink>
        <button
          type="button"
          class="menu-toggle"
          :aria-expanded="menuOpen"
          aria-controls="main-nav"
          @click="menuOpen = !menuOpen"
        >
          Menu
        </button>
        <nav id="main-nav" class="nav" :class="{ 'nav--open': menuOpen }" aria-label="Main">
          <NuxtLink
            v-for="link in links"
            :key="link.to"
            :to="link.to"
            class="nav__link"
            :class="{ 'nav__link--active': isActive(link) }"
            :aria-current="isActive(link) ? 'page' : undefined"
          >
            {{ link.label }}
          </NuxtLink>
          <div class="nav__user">
            <span v-if="user" class="nav__name" :title="user.email">{{ user.display_name }}</span>
            <button type="button" class="btn btn--ghost btn--small" :disabled="signingOut" @click="handleSignOut">
              {{ signingOut ? 'Signing out…' : 'Sign out' }}
            </button>
          </div>
        </nav>
      </div>
    </header>
    <main id="main" class="page">
      <slot />
    </main>
    <footer class="footer">
      <p>Garden Log · a journal for one garden</p>
    </footer>
  </div>
</template>
