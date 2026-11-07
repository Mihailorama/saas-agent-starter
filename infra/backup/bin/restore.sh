#!/bin/sh
# restore.sh --in-place|--new-instance [--target-time 'YYYY-MM-DD HH:MM:SS.mmm+00']
# Restores the repository into $PGDATA (latest state, or point in time). The server using that
# directory must be stopped. Called by `pnpm run restore` (scripts/backup.mjs), not by hand.
. /backup/bin/lib.sh
target='' mode=''
while [ $# -gt 0 ]; do
  case $1 in
  --target-time) target=$2 && shift 2 ;;
  --in-place) mode=preserve && shift ;;
  --new-instance) mode=off && shift ;; # a copy must never archive into the live repository
  *) mode= && break ;;
  esac
done
[ -n "$mode" ] || { echo "usage: restore.sh --in-place|--new-instance [--target-time <time>]" >&2 && exit 2; }
if [ -n "$target" ]; then
  set -- --type=time "--target=$target" --target-action=promote
else
  set --
fi
log "restoring into $PGDATA ${target:+to $target}"
pgbackrest restore --delta --pg1-path="$PGDATA" --archive-mode="$mode" "$@"
