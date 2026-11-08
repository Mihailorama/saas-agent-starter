# The "fresh VPS" of the infra e2e (deploy/setup/e2e.sh): Ubuntu with sshd, root login with a
# password, and cloud-init's sshd drop-in that turns password login on, as many cloud images ship.
# No Docker: the bootstrap installs it. Runs privileged with its own dockerd (Docker-in-Docker, the
# Kamal integration-test pattern). Test only, never a real server.
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server \
  && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd /root/.ssh /etc/docker && chmod 700 /root/.ssh \
  && echo 'root:local-dev-root-password' | chpasswd \
  && printf 'PasswordAuthentication yes\nPermitRootLogin yes\n' >/etc/ssh/sshd_config.d/50-cloud-init.conf \
  && printf '{ "insecure-registries": ["10.54.54.10:5000"] }\n' >/etc/docker/daemon.json
COPY --chmod=755 <<'EOF' /entrypoint.sh
#!/bin/sh
# cgroup v2: move ourselves out of the root cgroup so the inner dockerd can delegate controllers
# (what docker:dind's entrypoint does).
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 </sys/fs/cgroup/cgroup.procs >/sys/fs/cgroup/init/cgroup.procs 2>/dev/null || :
  sed -e 's/ / +/g' -e 's/^/+/' </sys/fs/cgroup/cgroup.controllers >/sys/fs/cgroup/cgroup.subtree_control || :
fi
exec /usr/sbin/sshd -D -e
EOF
ENTRYPOINT ["/entrypoint.sh"]
