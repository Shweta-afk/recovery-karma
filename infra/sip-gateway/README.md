# SamvadX SIP gateway

Lets agents call from the SamvadX page in their browser, with no VPN or softphone on their
computer. SkyCRM's call system only accepts voice traffic inside its private network, so this one
server sits in the middle:

```
Agent's browser ──wss://voice.samvadx.com/ws──▶ gateway ──IPsec──▶ SkyCRM call system ──▶ Tata line
   (SIP.js, headset)                      Kamailio + rtpengine          (10.173.16.10)
```

- **Kamailio** relays SIP. A browser's REGISTER is forwarded to SkyCRM with the contact rewritten
  to the gateway, so incoming calls for that extension come here and go to that browser.
  SkyCRM's own password check (digest auth) is what authenticates the agent.
- **rtpengine** converts browser audio (ICE + DTLS-SRTP) to plain RTP for SkyCRM, and back.
- **nginx** serves `wss://DOMAIN/ws` with a Let's Encrypt certificate and hands it to Kamailio.
- **Tunnel**: IPsec site-to-site to SkyCRM's FortiGate (`swanctl.conf.example`), our end
  `10.250.10.1` on loopback. `TUNNEL=fortivpn` (their SSL VPN, `tunnel-up.sh`) is for testing
  only. It allows one connection per login, so it knocks off an agent using the same login.

Call control (dial, hang up, queues, events) does NOT go through here. That stays on SkyCRM's
REST API from the app server (`src/lib/telephony/skycrm-provider.ts`).

## The live server (2026-11-03)

DigitalOcean droplet `samvadx-gateway`, Bangalore, Ubuntu 24.04, 2 GB, **168.144.28.194**, DNS
`voice.samvadx.com` (the old `sip` record at Hostinger would not change). SSH with the
`samvadx-gateway` key as root. The IPsec tunnel to SkyCRM is up, using our proposed settings,
which they accepted unchanged. SkyCRM's side as they stated it: WAN 118.185.178.161, LAN
10.173.16.10. We ask for 10.173.16.0/24 and their FortiGate accepts it (10.173.16.4 answers too).

Found through the tunnel: SkyCRM's own WebRTC endpoint is `wss://10.173.16.10:8089/ws` (also
`ws://…:8088/ws`, and the same on 10.173.16.4). This gateway still registers over SIP/UDP 5099;
whether to pass browsers through to their WebRTC instead is open.

## Setting up a server

1. Ubuntu 24.04, 2 GB RAM, fixed public IP. Open TCP 22/80/443 and UDP 500/4500/30000–30999 in
   any cloud firewall (setup.sh opens them in ufw). On DigitalOcean use the droplet's own public
   IP, not a Reserved IP: outgoing traffic (the IPsec tunnel) leaves from the droplet's IP.
2. DNS: an A record for `DOMAIN` pointing to the server's public IP.
3. On the server:
   ```bash
   git clone … && cd recovery-karma/infra/sip-gateway
   sudo cp gateway.env.example /etc/samvadx-gateway.env && sudo nano /etc/samvadx-gateway.env
   sudo ./setup.sh
   ```
   With `TUNNEL=ipsec` it asks once for SkyCRM's pre-shared key (`set-ipsec-psk.sh`; re-run that
   script on its own when SkyCRM changes the key). With `TUNNEL=fortivpn` it asks for the SSL VPN
   password.
4. Check: `curl https://DOMAIN/health` → `ok`; `sudo swanctl --list-sas` shows `skycrm-sip …
   INSTALLED`; `sudo kamcmd ul.dump` lists registered browsers.

## Browser side

The app's browser phone (`src/components/telephony/browser-phone.tsx`, in the agent and manager
layouts) gets each user's own extension from the server (`getMyWebphoneLogin`), with
`SKYCRM_WSS_URL=wss://voice.samvadx.com/ws`, `SKYCRM_SIP_DOMAIN=10.173.16.10` and
`SKYCRM_SIP_PASSWORD` set on Railway. Never put these in `VITE_*` variables: Vite bakes those
into the browser bundle.

## Known limits

- One server: if it is down, browser calling is down. Add monitoring, then a second gateway.
- Registrations are kept in memory: a restart makes every browser re-register (SIP.js does this
  by itself within a minute).
- Audio needs the browser to reach UDP 30000–30999. Very strict office networks that block UDP
  would need a TURN server; not set up.
- The IPsec pre-shared key was sent to us over chat. Ask SkyCRM to rotate it, then run
  `set-ipsec-psk.sh`.
