# Server bootstrap for `pnpm run infra` (scripts/infra.mjs, docs/setup.md). Runs as root on the
# server through `ssh <admin>@<host> sh -s` (or `sudo -n sh -s`); infra.mjs prepends
# DEPLOY_USER, DEPLOY_PATH, CLIENT_SSH_PORT (the port this client reached) and STEP. Debian or
# Ubuntu. Every step checks before it acts, so a
# re-run after a failure continues where it stopped.
#   STEP=base     Docker Engine + Compose from Docker's apt repository, the deploy user (docker
#                 group, the admin's authorized keys), DEPLOY_PATH, firewall (ufw: ssh, 80, 443)
#   STEP=harden   password login off (sshd drop-in), run only after a key login as the deploy
#                 user worked
#   STEP=ports    print the SSH ports the firewall keeps open (tests: SSHD_DUMP, SOCKET_LISTEN)
set -eu

# SSH ports to keep open: the one the client used, every `port` and `listenaddress host:port` of
# `sshd -T`, and the ListenStream of a socket-activated ssh.socket (it overrides sshd's Port).
ssh_ports() {
  dump=${SSHD_DUMP-$(sshd -T 2>/dev/null || :)}
  sock=${SOCKET_LISTEN-$(systemctl show -p Listen ssh.socket 2>/dev/null || :)}
  {
    printf '%s\n' "${CLIENT_SSH_PORT:-}"
    printf '%s\n' "$dump" | awk '$1 == "port" { print $2 } $1 == "listenaddress" { n = split($2, a, ":"); if (n > 1) print a[n] }'
    printf '%s\n' "$sock" | tr ' ' '\n' | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p'
  } | grep -E '^[0-9]+$' | sort -un | tr '\n' ' '
}
if [ "$STEP" = ports ]; then ssh_ports; exit 0; fi
[ "$(id -u)" = 0 ] || { echo "bootstrap: needs root (log in as root, or a user with passwordless sudo)" >&2; exit 1; }
. /etc/os-release
case "$ID" in debian | ubuntu) ;; *) echo "bootstrap: $ID is not supported (Debian or Ubuntu)" >&2; exit 1 ;; esac
export DEBIAN_FRONTEND=noninteractive PATH="/usr/sbin:/sbin:$PATH"
say() { printf '  %s\n' "$*"; }

if [ "$STEP" = base ]; then
  # Docker's apt repository (https://docs.docker.com/engine/install/), never the convenience script.
  if ! docker compose version >/dev/null 2>&1; then
    say "installing Docker Engine and the Compose plugin"
    apt-get update -qq
    apt-get install -yqq ca-certificates curl gnupg >/dev/null
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /tmp/docker.asc
    # Docker's release key, fingerprint from https://docs.docker.com/engine/install/
    gpg --show-keys --with-colons /tmp/docker.asc | grep -q '^fpr:*9DC858229FC7DD38854AE2D88D81803C0EBFCD88:' ||
      { echo "bootstrap: Docker's apt key has an unexpected fingerprint: not trusted" >&2; exit 1; }
    install -m 0644 /tmp/docker.asc /etc/apt/keyrings/docker.asc && rm -f /tmp/docker.asc
    printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
      "$ID" "${UBUNTU_CODENAME:-$VERSION_CODENAME}" >/etc/apt/sources.list.d/docker.sources
    apt-get update -qq
    apt-get install -yqq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  else
    say "Docker: $(docker --version)"
  fi
  command -v curl >/dev/null || apt-get install -yqq curl >/dev/null
  if [ -d /run/systemd/system ]; then systemctl enable --now docker >/dev/null 2>&1; else service docker start >/dev/null 2>&1 || :; fi
  i=0
  until docker info >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 30 ] || { echo "bootstrap: Docker does not start" >&2; exit 1; }; sleep 1
  done

  id "$DEPLOY_USER" >/dev/null 2>&1 || { useradd -m -s /bin/bash "$DEPLOY_USER"; say "created user $DEPLOY_USER"; }
  usermod -aG docker "$DEPLOY_USER"
  home=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
  install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$home/.ssh"
  keys="$home/.ssh/authorized_keys"
  touch "$keys"
  # The keys the admin logs in with (root, or the sudo user) also open the deploy user.
  admin_home=$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)
  [ -f "$admin_home/.ssh/authorized_keys" ] || { echo "bootstrap: $admin_home/.ssh/authorized_keys missing" >&2; exit 1; }
  while IFS= read -r k; do
    [ -z "$k" ] || grep -qxF "$k" "$keys" || printf '%s\n' "$k" >>"$keys"
  done <"$admin_home/.ssh/authorized_keys"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$keys" && chmod 600 "$keys"
  # A hardened sshd may let in only listed users: the key alone would then fail with a bare
  # "Permission denied". Say what to change instead (the run is safe to repeat).
  allowed=$(sshd -T 2>/dev/null | awk '$1 == "allowusers" { print $2 }' | tr '\n' ' ')
  if [ -n "$allowed" ] && ! printf '%s\n' $allowed | grep -qx "$DEPLOY_USER"; then
    echo "bootstrap: sshd AllowUsers ($allowed) leaves out $DEPLOY_USER: add it to that line in /etc/ssh/sshd_config(.d), reload ssh, run again" >&2
    exit 1
  fi
  install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_PATH"

  # Firewall: only SSH (the port(s) sshd listens on), 80 and 443. Docker's published ports bypass
  # ufw; compose.prod.yaml publishes only Caddy's 80/443 (and loopback-only ports).
  command -v ufw >/dev/null || apt-get install -yqq ufw >/dev/null
  ports=$(ssh_ports)
  [ -n "$ports" ] || { echo "bootstrap: cannot tell the SSH port: firewall left off (no lockout)" >&2; exit 1; }
  for p in $ports; do ufw allow "$p/tcp" >/dev/null; done
  for r in 80/tcp 443/tcp 443/udp; do ufw allow "$r" >/dev/null; done
  ufw default deny incoming >/dev/null
  ufw status | grep -q '^Status: active' || ufw --force enable >/dev/null
  say "firewall: $(ufw status | grep -c ALLOW) allow rules, everything else incoming denied"
fi

if [ "$STEP" = harden ]; then
  # sshd uses the FIRST value it reads, and Include sshd_config.d/*.conf sits at the top of
  # sshd_config. cloud-init writes 50-cloud-init.conf (often PasswordAuthentication yes), so our
  # drop-in must sort before it. Root keeps key-only login (prohibit-password, not no): each run
  # of `pnpm run infra` re-runs this bootstrap as the admin, and the deploy user has no sudo.
  f=/etc/ssh/sshd_config.d/01-infra.conf
  want='PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password'
  if [ "$(cat "$f" 2>/dev/null)" != "$want" ]; then
    mkdir -p /etc/ssh/sshd_config.d
    printf '%s\n' "$want" >"$f"
    sshd -t
    if [ -d /run/systemd/system ]; then
      systemctl reload ssh 2>/dev/null || systemctl reload sshd
    else
      kill -HUP "$(cat /run/sshd.pid 2>/dev/null || pgrep -o -x sshd)"
    fi
  fi
  sshd -T 2>/dev/null | grep -qx 'passwordauthentication no' || {
    echo "bootstrap: password login is still on: an earlier line in /etc/ssh/sshd_config overrides $f" >&2
    exit 1
  }
  sshd -T 2>/dev/null | grep -Eqx 'permitrootlogin (prohibit-password|without-password)' || {
    echo "bootstrap: root password login is still on: an earlier line overrides $f" >&2
    exit 1
  }
  say "ssh: password login off (root: keys only)"
fi
