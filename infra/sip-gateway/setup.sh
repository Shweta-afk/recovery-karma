#!/usr/bin/env bash
# One-time setup of the SamvadX SIP gateway on a fresh Ubuntu 24.04 server. Safe to re-run.
#   sudo ./setup.sh
# Needs /etc/samvadx-gateway.env (from gateway.env.example) and DOMAIN's DNS pointing here.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE=/etc/samvadx-gateway.env
[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "Create $ENV_FILE from gateway.env.example first." >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${DOMAIN:?}" "${CERTBOT_EMAIL:?set CERTBOT_EMAIL}" "${PUBLIC_IP:?}" "${TUNNEL:?}"
WS_PORT="${WS_PORT:-8090}"

echo "== Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q kamailio kamailio-websocket-modules kamailio-extra-modules \
  rtpengine-daemon nginx certbot ufw
case "$TUNNEL" in
  fortivpn) apt-get install -y -q openfortivpn ;;
  ipsec)    apt-get install -y -q strongswan-swanctl charon-systemd ;;
  *) echo "TUNNEL must be fortivpn or ipsec" >&2; exit 1 ;;
esac

echo "== Firewall"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 30000:30999/udp   # call audio to/from browsers
if [[ "$TUNNEL" == ipsec ]]; then
  ufw allow 500/udp          # IKE
  ufw allow 4500/udp         # IPsec through NAT
fi
ufw --force enable

echo "== Scripts and Kamailio config"
install -d /opt/samvadx-gateway
install -m 755 "$HERE/render.sh" /opt/samvadx-gateway/render.sh
install -m 644 "$HERE/kamailio.cfg" /etc/kamailio/kamailio.cfg
systemctl enable kamailio "${RTPENGINE_SERVICE:-rtpengine-daemon}"

echo "== TLS certificate for $DOMAIN"
if [[ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
  # Port 80 only until the certificate exists, or nginx refuses to start.
  sed -n '1,/^}/p' "$HERE/nginx-site.conf" | sed "s/__DOMAIN__/$DOMAIN/g" \
    > /etc/nginx/sites-available/samvadx-gateway
  ln -sf /etc/nginx/sites-available/samvadx-gateway /etc/nginx/sites-enabled/samvadx-gateway
  rm -f /etc/nginx/sites-enabled/default
  systemctl reload nginx
  certbot certonly --webroot -w /var/www/html -d "$DOMAIN" \
    --email "$CERTBOT_EMAIL" --agree-tos --non-interactive
fi
sed "s/__DOMAIN__/$DOMAIN/g; s/__WS_PORT__/$WS_PORT/g" "$HERE/nginx-site.conf" \
  > /etc/nginx/sites-available/samvadx-gateway
ln -sf /etc/nginx/sites-available/samvadx-gateway /etc/nginx/sites-enabled/samvadx-gateway
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
# Renewals must reload nginx to pick up the new certificate.
install -d /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx

echo "== Tunnel to SkyCRM ($TUNNEL)"
if [[ "$TUNNEL" == fortivpn ]]; then
  install -m 755 "$HERE/tunnel-up.sh" /etc/ppp/ip-up.d/samvadx-gateway
  if [[ ! -f /etc/openfortivpn/skycrm.conf ]]; then
    read -r -s -p "SkyCRM SSL VPN password for API_Test1: " VPN_PASS; echo
    install -d -m 700 /etc/openfortivpn
    sed "s|__PASSWORD__|$VPN_PASS|" "$HERE/openfortivpn.conf.example" > /etc/openfortivpn/skycrm.conf
    chmod 600 /etc/openfortivpn/skycrm.conf
  fi
  systemctl enable --now openfortivpn@skycrm
  echo "Waiting for the VPN..."
  for _ in $(seq 1 30); do ip -4 addr show ppp0 >/dev/null 2>&1 && break; sleep 2; done
  ip -4 addr show ppp0 >/dev/null 2>&1 || { echo "VPN did not come up: journalctl -u openfortivpn@skycrm" >&2; exit 1; }
else
  [[ -f /etc/swanctl/conf.d/skycrm.conf ]] || {
    echo "Write /etc/swanctl/conf.d/skycrm.conf from swanctl.conf.example (needs SkyCRM's IPsec details), then re-run." >&2
    exit 1
  }
  systemctl enable --now strongswan
  swanctl --load-all
fi

/opt/samvadx-gateway/render.sh
echo "== Done. Check: curl https://$DOMAIN/health"
