// Dark mode for the static site: follow the OS, like the app's default. The tokens are the web
// app's (`.dark` on <html>, apps/web/src/index.css). A file, not inline: the CSP allows
// script-src 'self' only. Loaded in <head> before paint, so there is no light flash.
const dark = matchMedia('(prefers-color-scheme: dark)');
const apply = () => document.documentElement.classList.toggle('dark', dark.matches);
apply();
dark.addEventListener('change', apply);
