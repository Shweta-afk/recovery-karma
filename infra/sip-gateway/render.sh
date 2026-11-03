#!/usr/bin/env bash
# Writes Kamailio's and rtpengine's local settings from /etc/samvadx-gateway.env and restarts
# both. Run by setup.sh, and by tunnel-up.sh whenever the test VPN gets a new address.
set -euo pipefail

ENV_FILE=/etc/samvadx-gateway.env
# shellcheck disable=SC1090
source "$ENV_FILE"

: "${PBX_IP:?set PBX_IP in $ENV_FILE}"
: "${PBX_PORT:?set PBX_PORT in $ENV_FILE}"
: "${PUBLIC_IP:?set PUBLIC_IP in $ENV_FILE}"
WS_PORT="${WS_PORT:-8090}"
PRIVATE_IP="${PRIVATE_IP:-$(ip -4 route get 1.1.1.1 | awk '{for (i=1;i<NF;i++) if ($i=="src") print $(i+1)}')}"

if [[ -z "${TUNNEL_IP:-}" ]]; then
  echo "TUNNEL_IP is not known yet (tunnel not up?) - nothing to render." >&2
  exit 0
fi

# Kamailio: plain text substitution, applied before the config is parsed. The origin regex is a
# #!define instead, because substdef would read its "$" as a variable.
cat > /etc/kamailio/gateway-local.cfg <<EOF
#!substdef "!TUNNEL_IP!${TUNNEL_IP}!g"
#!substdef "!PBX_IP!${PBX_IP}!g"
#!substdef "!PBX_PORT!${PBX_PORT}!g"
#!substdef "!WS_PORT!${WS_PORT}!g"
#!define ALLOWED_ORIGINS "${ALLOWED_ORIGINS}"
EOF

# rtpengine: "internal" faces SkyCRM through the tunnel, "external" faces browsers (behind the
# cloud NAT, so it advertises the public IP).
cat > /etc/rtpengine/rtpengine.conf <<EOF
[rtpengine]
table = -1
interface = internal/${TUNNEL_IP};external/${PRIVATE_IP}!${PUBLIC_IP}
listen-ng = 127.0.0.1:2223
port-min = 30000
port-max = 30999
tos = 184
log-level = 6
log-facility = local1
EOF

kamailio -c -f /etc/kamailio/kamailio.cfg >/dev/null
# rtpengine first: Kamailio pings it at startup and disables it if it isn't answering yet.
systemctl restart "${RTPENGINE_SERVICE:-rtpengine-daemon}"
sleep 2
systemctl restart kamailio
echo "Gateway rendered: tunnel ${TUNNEL_IP}, SkyCRM ${PBX_IP}:${PBX_PORT}, public ${PUBLIC_IP}."
