<template>
  <div class="shell">
    <header class="masthead">Sample notes</header>
    <main>
      <NuxtPage />
    </main>
  </div>
</template>

<style>
body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: #fafafa;
  color: #1a1a1a;
}
.shell {
  max-width: 640px;
  margin: 0 auto;
  padding: 16px;
}
.masthead {
  font-weight: 600;
  padding-bottom: 12px;
  border-bottom: 1px solid #ddd;
  margin-bottom: 16px;
}
label {
  display: block;
  margin: 12px 0;
}
input,
textarea {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  font: inherit;
}
button {
  padding: 8px 16px;
  font: inherit;
}
.error {
  color: #b00020;
}
.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 6px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
