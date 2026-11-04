#!/usr/bin/env bash
# Option B (user's decision, 2026-11-04): agents' browsers talk WebRTC straight to SkyCRM's own
# WebRTC endpoint (wss://PBX_IP:PBX_WSS_PORT/ws), carried through this gateway — no VPN on agents'
# computers, and SkyCRM's extensions set to WebRTC.
#
#   browser ──wss://DOMAIN/skycrm-ws──▶ nginx ──(from TUNNEL_IP, IPsec)──▶ SkyCRM 10.173.16.10:8089
#   browser ──TURN udp/tcp 3478──▶ coturn ──relay from TUNNEL_IP, IPsec──▶ SkyCRM audio
#
# Safe to re-run. Leaves the softphone route (wss://DOMAIN/ws → Kamailio) in place, so going
# back is only SKYCRM_WSS_URL on Railway + SkyCRM switching the extensions back to softphone.
#   sudo ./enable-skycrm-webrtc.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE=/etc/samvadx-gateway.env
[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${DOMAIN:?}" "${PBX_IP:?}" "${TUNNEL_IP:?TUNNEL_IP must be set (IPsec tunnel)}"
PBX_WSS_PORT="${PBX_WSS_PORT:-8089}"
WS_PORT="${WS_PORT:-8090}"
SKYCRM_NET_FROM="${SKYCRM_NET_FROM:-10.173.16.0}"
SKYCRM_NET_TO="${SKYCRM_NET_TO:-10.173.16.255}"
LISTEN_IP="${PRIVATE_IP:-$(ip -4 route get 1.1.1.1 | awk '{for (i=1;i<NF;i++) if ($i=="src") print $(i+1)}')}"

echo "== Can we reach SkyCRM's WebRTC through the tunnel?"
if curl -sk -m 8 --interface "$TUNNEL_IP" -o /dev/null "https://$PBX_IP:$PBX_WSS_PORT/ws"; then
  echo "   yes: https://$PBX_IP:$PBX_WSS_PORT/ws answers"
else
  echo "   NO answer from https://$PBX_IP:$PBX_WSS_PORT/ws from $TUNNEL_IP." >&2
  echo "   Check 'swanctl --list-sas' and ask SkyCRM whether WebRTC is on." >&2
  exit 1
fi

echo "== coturn (audio relay)"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -q coturn
SECRET="$(sed -n 's/^static-auth-secret=//p' /etc/turnserver.conf 2>/dev/null || true)"
[[ -n "$SECRET" && "$SECRET" != "__TURN_SECRET__" ]] || SECRET="$(openssl rand -hex 32)"
sed -e "s|__LISTEN_IP__|$LISTEN_IP|g" -e "s|__TUNNEL_IP__|$TUNNEL_IP|g" \
  -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__TURN_SECRET__|$SECRET|g" \
  -e "s|__PEER_FROM__|$SKYCRM_NET_FROM|g" -e "s|__PEER_TO__|$SKYCRM_NET_TO|g" \
  "$HERE/turnserver.conf.example" > /etc/turnserver.conf
chmod 640 /etc/turnserver.conf
chgrp turnserver /etc/turnserver.conf 2>/dev/null || true
[[ -f /etc/default/coturn ]] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
systemctl enable coturn
systemctl restart coturn

echo "== Firewall"
ufw allow 3478/udp
ufw allow 3478/tcp
# SkyCRM's audio comes back to the relay through the tunnel.
ufw allow from "$SKYCRM_NET_FROM/24" to any port 49160:49999 proto udp

echo "== nginx: wss://$DOMAIN/skycrm-ws → https://$PBX_IP:$PBX_WSS_PORT/ws"
# Same allow-list as Kamailio's /ws (ALLOWED_ORIGINS in $ENV_FILE). A map lives at http level.
cat > /etc/nginx/conf.d/samvadx-origin.conf <<NGX
map \$http_origin \$samvadx_origin_ok {
    default 0;
    "~${ALLOWED_ORIGINS}" 1;
}
NGX
install -d /etc/nginx/samvadx-gateway.d
cat > /etc/nginx/samvadx-gateway.d/skycrm-ws.conf <<NGX
location = /skycrm-ws {
    if (\$samvadx_origin_ok = 0) { return 403; }
    proxy_pass https://$PBX_IP:$PBX_WSS_PORT/ws;
    # Leave from our tunnel address, so the IPsec policy carries it to SkyCRM.
    proxy_bind $TUNNEL_IP;
    # SkyCRM's certificate is self-signed; browsers only ever see ours.
    proxy_ssl_verify off;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Host $PBX_IP:$PBX_WSS_PORT;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
NGX
sed "s/__DOMAIN__/$DOMAIN/g; s/__WS_PORT__/$WS_PORT/g" "$HERE/nginx-site.conf" \
  > /etc/nginx/sites-available/samvadx-gateway
nginx -t
systemctl reload nginx

cat <<DONE

Done. Set these on Railway (recoveryai-app → Variables), then redeploy:
  SKYCRM_WSS_URL=wss://$DOMAIN/skycrm-ws
  TURN_URLS=turn:$DOMAIN:3478?transport=udp,turn:$DOMAIN:3478?transport=tcp
  TURN_SECRET=$SECRET
Keep TURN_SECRET private. Check: systemctl status coturn; journalctl -u coturn -f during a call.
To go back to the softphone route: SKYCRM_WSS_URL=wss://$DOMAIN/ws (and SkyCRM sets the
extensions back to softphone).
DONE
