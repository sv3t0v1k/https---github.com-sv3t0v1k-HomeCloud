#!/bin/sh
# Проверка выполняется ДО initdb, migrations и любого штатного helper writer.
# Никакой записи, ожидания mount или fallback. Root/Docker admin вне модели защиты.
set -eu
stop() { echo 'STOP: HomeCloud startup disk gate' >&2; exit 1; }
[ "$#" -ge 2 ] || stop
role=$1; shift
case "$role" in
  db) data=/var/lib/postgresql/data; [ "${PGDATA:-$data}" = "$data" ] || stop;;
  backend) data=/storage; [ "${STORAGE_PATH:-$data}" = "$data" ] || stop;;
  *) stop;;
esac
check() {
config=/run/homecloud/startup.gate
[ -f "$config" ] && [ ! -L "$config" ] || stop
[ "$(stat -c '%u:%g:%a' "$config")" = '0:0:644' ] || stop
# Единственная строка без shell interpolation; пути с пробелами не поддерживаются.
[ "$(wc -l < "$config" | tr -d ' ')" = 1 ] || stop
IFS=' ' read -r configured_role uuid host_mount host_data uid gid identity_mode extra < "$config" || stop
[ "$configured_role" = "$role" ] && [ -z "$extra" ] || stop
identity_mode=${identity_mode:-dedicated}
case "$identity_mode" in
  dedicated) :;;
  system-root-lvm) [ "$role" = db ] && [ "$host_mount" = / ] || stop;;
  *) stop;;
esac
case "$uuid" in ''|*[!a-zA-Z0-9-]*) stop;; esac
case "$uid:$gid" in *[!0-9:]*|:|0:*|*:0) stop;; esac
case "$host_mount:$host_data" in *[!a-zA-Z0-9_./:-]*|*..*) stop;; esac
case "$host_data" in /|*/|[!/]*) stop;; esac
if [ "$identity_mode" = system-root-lvm ]; then
  relative=$host_data
else
  case "$host_mount" in /|*/|[!/]*) stop;; esac
  case "$host_data" in "$host_mount"/*) relative=${host_data#"$host_mount"};; *) stop;; esac
fi

# Устройство берётся из udev UUID alias на host. Читаем только metadata, не block I/O.
device=/run/homecloud/dev/disk/by-uuid/$uuid
[ -L "$device" ] || stop
alias=$(readlink "$device")
case "$alias" in ../../*) node=${alias#../../};; *) stop;; esac
case "$node" in ''|*[!a-zA-Z0-9_-]*) stop;; esac
[ -b "$device" ] || stop
major_hex=$(stat -L -c '%t' "$device"); minor_hex=$(stat -L -c '%T' "$device")
expected_device="$((0x$major_hex)):$((0x$minor_hex))"
expected_source=/dev/$node

# Dedicated retains exact textual source. Root LVM may expose /dev/mapper/name
# in mountinfo but /dev/dm-N in UUID alias. Compare block metadata, never read I/O.
source_matches() {
  if [ "$identity_mode" = dedicated ]; then
    [ "$1" = "$expected_source" ]
  else
    case "$node" in dm-[0-9]*) :;; *) return 1;; esac
    case "$1" in /dev/mapper/*|/dev/dm-*) :;; *) return 1;; esac
    case "$1" in *[!a-zA-Z0-9_./-]*|*..*) return 1;; esac
    source_device=/run/homecloud/dev/${1#/dev/}
    [ -b "$source_device" ] || return 1
    source_major=$(stat -L -c '%t' "$source_device") || return 1
    source_minor=$(stat -L -c '%T' "$source_device") || return 1
    [ "$((0x$source_major)):$((0x$source_minor))" = "$expected_device" ]
  fi
}

# exact target, один mount, ext4/xfs; вывод только числовой identity/root/options.
mount_record() {
  awk -v target="$2" '
    $5 == target { n++; for(i=7;i<=NF;i++) if($i=="-") {
      if($(i+1)!="ext4" && $(i+1)!="xfs") exit 2;
      print $3, $4, $6, $(i+2), $(i+3)
    }}
    END { if(n!=1) exit 2 }
  ' "$1"
}
record=$(mount_record /run/homecloud/host-mountinfo "$host_mount") || stop
set -- $record
[ "$#" = 5 ] && [ "$1" = "$expected_device" ] && [ "$2" = / ] && source_matches "$4" || stop
if [ "$identity_mode" = system-root-lvm ]; then
  awk '$5=="/" {for(i=7;i<=NF;i++) if($i=="-") {if($(i+1)!="ext4") exit 1}}' /run/homecloud/host-mountinfo || stop
fi
case ",$3," in *,rw,*) :;; *) stop;; esac
case ",$5," in *,rw,*) :;; *) stop;; esac
# Проверяем собственный bind: правильный host mount НЕ исправляет старый underlay bind.
record=$(mount_record /proc/self/mountinfo "$data") || stop
set -- $record
[ "$#" = 5 ] && [ "$1" = "$expected_device" ] && [ "$2" = "$relative" ] && source_matches "$4" || stop
case ",$3," in *,rw,*) :;; *) stop;; esac
case ",$5," in *,rw,*) :;; *) stop;; esac
awk -v root="$data/" 'index($5,root)==1 {bad=1} END {exit bad}' /proc/self/mountinfo || stop
[ "$(readlink -f "$data")" = "$data" ] || stop
[ "$(stat -c '%u:%g:%a' "$data")" = "$uid:$gid:700" ] || stop

# Marker вне PGDATA: initdb требует пустой каталог; marker не включается в D1 swap.
marker=/run/homecloud/volume-marker
[ -f "$marker" ] && [ ! -L "$marker" ] || stop
[ "$(stat -c '%u:%g:%a' "$marker")" = "$uid:$gid:400" ] || stop
[ "$(cat "$marker")" = "homecloud-v1 $role $uuid" ] || stop
record=$(mount_record /proc/self/mountinfo "$marker") || stop
set -- $record
[ "$#" = 5 ] && [ "$1" = "$expected_device" ] && [ "$2" = "${relative%/*}/.homecloud-$role" ] && source_matches "$4" || stop

if [ "$role" = backend ]; then
  [ "$(readlink -f "$data/.tmp")" = "$data/.tmp" ] || stop
  [ -d "$data/.tmp" ] && [ "$(stat -c '%u:%g:%a' "$data/.tmp")" = "$uid:$gid:700" ] || stop
else
  [ ! -L "$data/pg_wal" ] && [ ! -L "$data/pg_tblspc" ] || stop
  if [ -d "$data/pg_tblspc" ]; then
    [ -z "$(ls -A "$data/pg_tblspc")" ] || stop
  fi
fi
}
check
echo 'PASS: HomeCloud startup disk gate'
# Исходный argv сохраняется вне функции: штатные D1 helpers тоже проходят gate.
case "$role" in
  db) exec /usr/local/bin/docker-entrypoint.sh "$@";;
  backend) exec sh docker/entrypoint.sh "$@";;
esac
