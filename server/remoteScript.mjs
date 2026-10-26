/**
 * The payload run on every server through a single SSH exec.
 *
 * POSIX-sh compatible (dash/bash). Nothing requires root: the quota section is
 * simply empty when we lack privilege, which is what triggers the du fallback.
 *
 * Sections: HOST KERNEL DATE UPTIME IDENTITY DF USERS QUOTA DU NASDU USAGE_ERR
 *
 * DU    -> per-account home, one level deep (gives the account total + its
 *          subdirectories in a single traversal)
 * NASDU -> one level deep on every network mount; only the designated scanner
 *          server pays this cost, because all 9 machines mount the same share.
 */

import { buildLxdScript } from './lxd.mjs'

export function buildRemoteScript({ scanNas, withLxd = true, execFallback = true }) {
  const nasBlock = scanNas
    ? String.raw`
echo "$S:NASDU"
if command -v findmnt >/dev/null 2>&1; then
  NASLIST=$(findmnt -rno TARGET -t cifs,nfs,nfs4,smb,smb3,fuse,fuse.sshfs 2>/dev/null)
fi
if [ -z "$NASLIST" ]; then
  NASLIST=$(df -PT 2>/dev/null | awk 'NR>1 {t=tolower($2); if (t=="cifs"||t=="nfs"||t=="nfs4"||t=="smb"||t=="smb2"||t=="smb3"||t ~ /^fuse/) print $NF}')
fi
for m in $NASLIST; do
  [ -d "$m" ] && duscan "$m"
done
`
    : String.raw`
echo "$S:NASDU"
echo "SKIPPED:not-scanner"
`

  return String.raw`
export LC_ALL=C
S=@@SEC

duscan() {
  if [ -n "$T" ]; then
    $T du -k --max-depth=1 -- "$1" 2>/dev/null || $T du -k -d 1 -- "$1" 2>/dev/null
  else
    du -k --max-depth=1 -- "$1" 2>/dev/null || du -k -d 1 -- "$1" 2>/dev/null
  fi
}

if command -v timeout >/dev/null 2>&1; then T="timeout 200"; else T=""; fi

echo "$S:HOST"; hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null
echo "$S:KERNEL"; uname -sr 2>/dev/null
echo "$S:DATE"; date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null; date +%s 2>/dev/null
# 必须自带换行：以前用 printf "%d" 不带换行，会把后面的 @@SEC 标记粘到本行里，
# 结果 IDENTITY 段整个丢失、uptime 也解析成 NaN（界面上"运行 —"就是这么来的）。
echo "$S:UPTIME"; awk '{print int($1)}' /proc/uptime 2>/dev/null
echo "$S:IDENTITY"; id -u 2>/dev/null; echo "user=$(id -nu 2>/dev/null)"

echo "$S:DF"
df -PT -k 2>/dev/null || df -P -k 2>/dev/null

echo "$S:USERS"
awk -F: '($3>=1000 && $3<65534) || $1=="root" {print $1"\t"$3"\t"$6"\t"$7}' /etc/passwd 2>/dev/null

echo "$S:QUOTA"
if [ "$(id -u 2>/dev/null)" = "0" ]; then
  repquota -a 2>/dev/null
elif command -v repquota >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
  # 直接试目标命令，不要用 "sudo -n true" 预判：受限 sudoers 下那条必然被拒
  sudo -n repquota -a 2>/dev/null
fi

echo "$S:DU"
HOME_DIRS=$(ls -1d /home/*/ 2>/dev/null | sed 's:/$::')
PASSWD_DIRS=$(awk -F: '($3>=1000 && $3<65534) || $1=="root" {print $6}' /etc/passwd 2>/dev/null)
SEEN=""
for d in $HOME_DIRS $PASSWD_DIRS; do
  case "$d" in
    /*) ;;
    *) continue ;;
  esac
  [ -d "$d" ] || continue
  case " $SEEN " in
    *" $d "*) continue ;;
  esac
  SEEN="$SEEN $d"
  echo "@@HOME$d"
  duscan "$d"
done
` + nasBlock + (withLxd ? buildLxdScript({ allowExecFallback: execFallback }) : '') + String.raw`
echo "$S:END"
`
}

export const SEPARATOR = '@@SEC'
