# SkyCRM meeting — likely questions and short answers

## How we connect
**How do you call our API?**
From our application server only, over HTTPS POST. Agents' browsers never call your API directly.

**How do you authenticate?**
Every request has `Authorization: Bearer <token>`. The token is HS256, signed with the secret you gave us, with username, password, extension and a one-hour expiry. A new token is made for each request, for the extension making it.

**Why form-encoded and not JSON?**
Your server reads `request.POST`, which only sees form fields. With JSON every field arrives empty and your server answers `'NoneType' object is not subscriptable`. Only `disposition_api` is the opposite: it needs JSON.

**How do you know a request worked?**
We read the `status` inside your response. You return HTTP 200 even for failures, so `status: 300` in the body is a failure.

**What phone number format do you send?**
Plain 10 digits. `+91…` or `0…` came back as NO ANSWER.

**What prefix do you send?**
The agent's own extension (for example, 8601 dials "8601" + number).

## Gateway and audio
**How do agents connect for voice?**
From the SamvadX web page using your WebRTC (`wss://10.173.16.10:8089/ws`), through our gateway `voice.samvadx.com`, over the IPsec tunnel to your FortiGate. Audio goes through our TURN relay, which only forwards to your network `10.173.16.0/24`.

**Is your tunnel set up correctly?**
Yes: IKEv2, pre-shared key, AES-256 / SHA-256 / DH group 14 on both phases, the same as your DC_To_Axiotta settings. It's ESTABLISHED with traffic flowing both ways (show `sudo swanctl --list-sas`).

**Ping to 10.173.16.10 fails.**
That's your firewall dropping ping. The tunnel passes traffic, and your WebRTC port answers through it (HTTP 426).

**Do agents need FortiClient or Zoiper?**
No. That was only for early testing; the permanent site-to-site tunnel replaced it.

## Each feature
**Do you receive our webhook events?**
Yes, since 4 November, at `/api/telephony/webhook`. Before that the webhook URL wasn't set on your side.

**How do you match events to calls?**
By `callid`. If an event has none, by the open call on that extension or customer number.

**How do you get recordings?**
`cdr_report` for the list, then `download_audio/` with the CDR id. We store the files in our own private storage. Your document's `download-audio` path gives a 404.

**Are dispositions reaching you?**
Yes, through `disposition_api` as JSON, since 5 November. Before that we sent form data and you answered "Invalid JSON".

**How do you create users?**
Through `users_webhook_api`. It has no authentication, which we'd like you to add.

**Why isn't predictive dialling live?**
We're waiting for our queue number from you. The code is ready: login_in_queue1 → predictive_call → logout_queue1.

**What's wrong with Listen / Whisper / Barge?**
The supervisor's phone rings and your API says success, but there's no sound. We send agent = `user_extention`, supervisor = `monitor_extention`. Normal calls through the same path do have sound.

## If you don't know an answer
"Let me check with our tech team and send it to you in writing today."
