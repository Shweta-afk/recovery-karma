#!/usr/bin/env bash
# pppd ip-up hook (installed as /etc/ppp/ip-up.d/samvadx-gateway) for the TEST tunnel only:
# openfortivpn's address can change on every connect, so record it and re-render the gateway.
# pppd calls it as: <interface> <tty> <speed> <local-ip> <remote-ip> <ipparam>
set -euo pipefail

IFACE="${1:-}"
LOCAL_IP="${4:-}"
ENV_FILE=/etc/samvadx-gateway.env

grep -q '^TUNNEL=fortivpn' "$ENV_FILE" || exit 0
[[ "$IFACE" == ppp* && -n "$LOCAL_IP" ]] || exit 0

if grep -q '^TUNNEL_IP=' "$ENV_FILE"; then
  sed -i "s/^TUNNEL_IP=.*/TUNNEL_IP=${LOCAL_IP}/" "$ENV_FILE"
else
  echo "TUNNEL_IP=${LOCAL_IP}" >> "$ENV_FILE"
fi

/opt/samvadx-gateway/render.sh | logger -t samvadx-gateway
