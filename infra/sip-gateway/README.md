# SamvadX SIP gateway

Lets agents call from the SamvadX page in their browser, with no VPN or softphone on their
computer. SkyCRM's call system only accepts voice traffic inside its private network, so this one
server sits in the middle:

```
Agent's browser ──wss://sip.samvadx.com/ws──▶ gateway ──tunnel──▶ SkyCRM call system ──▶ Tata line
   (SIP.js, headset)                      Kamailio + rtpengine      (SIP over UDP, G.711)
```

- **Kamailio** relays SIP. A browser's REGISTER is forwarded to SkyCRM with the contact rewritten
  to the gateway, so incoming calls for that extension come here and go to that browser.
  SkyCRM's own password check (digest auth) is what authenticates the agent.
- **rtpengine** converts browser audio (ICE + DTLS-SRTP) to plain RTP for SkyCRM, and back.
- **nginx** serves `wss://DOMAIN/ws` with a Let's Encrypt certificate and hands it to Kamailio.
- **Tunnel**: `openfortivpn` on SkyCRM's SSL VPN (`API_Test1`) for testing; IPsec site-to-site
  (`swanctl.conf.example`) in production. Only `fortivpn` needs `tunnel-up.sh`.

Call control (dial, hang up, queues, events) does NOT go through here. That stays on SkyCRM's
REST API from the app server (`src/lib/telephony/skycrm-provider.ts`).

## Setting up a server

1. Ubuntu 24.04, 2 GB RAM, fixed public IP. Open TCP 22/80/443 and UDP 30000–30999 in the
   cloud firewall (plus UDP 500/4500 for IPsec). On DigitalOcean use the droplet's own public IP,
   not a Reserved IP: outgoing traffic (the IPsec tunnel) leaves from the droplet's IP.
2. DNS: an A record for `sip.samvadx.com` pointing to the server's public IP.
3. On the server:
   ```bash
   git clone … && cd recovery-karma/infra/sip-gateway
   sudo cp gateway.env.example /etc/samvadx-gateway.env && sudo nano /etc/samvadx-gateway.env
   sudo ./setup.sh
   ```
   With `TUNNEL=fortivpn` it asks for the SSL VPN password once.
4. Check: `curl https://sip.samvadx.com/health` → `ok`; `sudo kamcmd ul.dump` lists registered
   browsers.

## Moving to IPsec (production)

Fill `swanctl.conf.example` from SkyCRM's settings into `/etc/swanctl/conf.d/skycrm.conf`, set
`TUNNEL=ipsec` and `TUNNEL_IP` in `/etc/samvadx-gateway.env`, stop `openfortivpn@skycrm`, and
re-run `setup.sh`.

## Browser side

The webphone (`src/lib/telephony/webrtc/`) needs `VITE_SKYCRM_WSS_URL=wss://sip.samvadx.com/ws`
and `VITE_SKYCRM_SIP_DOMAIN=` SkyCRM's registrar (`10.173.16.10` on the test setup).
⚠️ The extension's SIP password is still a `VITE_*` value in the browser bundle — test only.
Before client companies use it, the app server must hand each agent their own password at sign-in.

## Known limits

- One server: if it is down, browser calling is down. Add monitoring, then a second gateway.
- Registrations are kept in memory: a restart makes every browser re-register (SIP.js does this
  by itself within a minute).
- Audio needs the browser to reach UDP 30000–30999. Very strict office networks that block UDP
  would need a TURN server; not set up.
