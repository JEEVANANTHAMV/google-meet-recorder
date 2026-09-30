# Recording spool on the instance-store SSD

The recorder writes live recordings to `SPOOL_DIR=/mnt/gmr-spool/spool` (set in the server's
`test-server/.env`) on the EC2 instance-store NVMe SSD (~412 GB free), then uploads each one to GCS
when the class ends.

- `gmr-spool-disk.sh` — finds the instance-store disk by model name, formats it if blank, mounts it
  on `/mnt/gmr-spool`, creates `spool/` owned by `ubuntu`. Falls back to the root disk if no
  instance-store disk exists.
- `gmr-spool-disk.service` — runs the script at boot, before `pm2-ubuntu.service`.

Install on a new server:

    sudo install -m 755 gmr-spool-disk.sh /usr/local/sbin/gmr-spool-disk.sh
    sudo install -m 644 gmr-spool-disk.service /etc/systemd/system/gmr-spool-disk.service
    sudo systemctl daemon-reload && sudo systemctl enable --now gmr-spool-disk.service

Instance storage survives a reboot but is wiped by an instance stop/start. Only recordings in
progress at that moment are affected; the disk is re-formatted automatically on the next boot.
