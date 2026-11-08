# After-deploy step of the analytics component (Umami, compose.prod.yaml), run by
# `pnpm run infra` in DEPLOY_PATH: replaces Umami's default admin/umami login with
# UMAMI_ADMIN_PASSWORD from .env. Idempotent: done once that password logs in. The password
# reaches the container on stdin, never argv or logs.
set -eu
grep '^UMAMI_ADMIN_PASSWORD=' .env | cut -d= -f2- | docker compose exec -T umami node -e '
let pw = "";
process.stdin.on("data", (d) => (pw += d)).on("end", async () => {
  pw = pw.trim();
  const post = (path, body, token) =>
    fetch(`http://127.0.0.1:3000/api${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  const login = async (password) => {
    const r = await post("/auth/login", { username: "admin", password });
    return r.ok ? (await r.json()).token : undefined;
  };
  if (!pw) throw new Error("UMAMI_ADMIN_PASSWORD is not set");
  if (await login(pw)) return console.log("  umami: admin password in place");
  const token = await login("umami");
  if (!token) throw new Error("umami: neither the default login nor UMAMI_ADMIN_PASSWORD works");
  const r = await post("/me/password", { currentPassword: "umami", newPassword: pw }, token);
  if (!r.ok) throw new Error(`umami: password change failed (HTTP ${r.status})`);
  console.log("  umami: default admin password replaced");
});'
