// Apply the saved theme before first paint (no flash). External file: CSP allows no inline scripts.
const theme = localStorage.getItem('theme');
if (theme === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.documentElement.classList.add('dark');
}
