#!/usr/bin/env bash
# Asks for SkyCRM's IPsec pre-shared key (hidden) and saves it where only root can read it.
#   sudo ./set-ipsec-psk.sh        (setup.sh runs it the first time; re-run when the key changes)
# The key is matched on either our ID or theirs, so a different ID on their side still works.
set -euo pipefail

ENV_FILE=/etc/samvadx-gateway.env
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${PUBLIC_IP:?set PUBLIC_IP in $ENV_FILE}" "${SKYCRM_PEER_IP:?set SKYCRM_PEER_IP in $ENV_FILE}"

read -r -s -p "SkyCRM IPsec pre-shared key: " KEY; echo
[[ -n "$KEY" ]] || { echo "Empty key, nothing saved." >&2; exit 1; }

umask 077
printf 'secrets {\n  ike-skycrm {\n    id-local = %s\n    id-remote = %s\n    secret = "%s"\n  }\n}\n' \
  "$PUBLIC_IP" "$SKYCRM_PEER_IP" "$KEY" > /etc/swanctl/conf.d/skycrm-secret.conf
chmod 600 /etc/swanctl/conf.d/skycrm-secret.conf
echo "Saved. Length ${#KEY} characters."

if systemctl is-active --quiet strongswan; then
  swanctl --load-creds >/dev/null && echo "Loaded into strongSwan."
fi
