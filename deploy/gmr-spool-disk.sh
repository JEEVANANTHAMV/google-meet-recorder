#!/bin/bash
# Prepares the EC2 instance-store NVMe SSD as the Google Meet Recorder spool (/mnt/gmr-spool/spool).
# Instance storage comes back BLANK after an instance stop/start (new disk, new serial), so the disk
# is located by its model name and formatted whenever it has no filesystem. Runs before pm2.
# If no instance-store disk exists, the spool directory is created on the root disk instead.
set -euo pipefail
MNT=/mnt/gmr-spool
mkdir -p "$MNT"
if ! mountpoint -q "$MNT"; then
  LINK=$(ls /dev/disk/by-id/nvme-Amazon_EC2_NVMe_Instance_Storage_* 2>/dev/null | grep -v "_1$" | head -1 || true)
  if [ -n "$LINK" ]; then
    DEV=$(readlink -f "$LINK")
    if ! blkid "$DEV" >/dev/null 2>&1; then
      echo "gmr-spool: formatting blank instance-store disk $DEV"
      mkfs.ext4 -q -F -L gmr-spool "$DEV"
    fi
    mount -o noatime "$DEV" "$MNT"
    echo "gmr-spool: mounted $DEV on $MNT"
  else
    echo "gmr-spool: no instance-store disk found; spool stays on the root disk"
  fi
fi
mkdir -p "$MNT/spool"
chown ubuntu:ubuntu "$MNT/spool"
