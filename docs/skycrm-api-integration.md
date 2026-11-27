# SamvadX × SkyCRM-ACD — API integration

How SamvadX calls the SkyCRM-ACD API (spec v1.2). Tokens, secrets and phone numbers below are masked.

## Connection

| Item | Value |
|---|---|
| Base URL | `https://vs.skycrm.app` |
| Who calls | SamvadX application server only (browsers never call SkyCRM) |
| Method | `POST` |
| Body | `application/x-www-form-urlencoded` (except `disposition_api`: JSON) |
| Success | the `status` field in the response body (`200` = success), not the HTTP code |
| Phone format | plain 10-digit Indian number |
| Prefix | the agent's own extension |

## Authentication

Every request carries a fresh, short-lived token:

```
Authorization: Bearer <JWT>
```

JWT, HS256, signed with the shared secret SkyCRM issued to us:

```json
{
  "username": "<agent's SkyCRM user>",
  "password": "<agent's SkyCRM password>",
  "extension": "8601",
  "exp": 1763540000
}
```

A token is minted per request, for the extension making that request.

## Calls we make

### Click-to-call: `POST /dialing_phone`
```
phone_number=98XXXXXX10
extension=8601
prefix=8601
per_id=<our call id>
```
Before dialling we check the agent's phone is registered: `POST /dial_response` with `extension=8601`.

### Hang up: `POST /hangup_phone`
```
phone_number=98XXXXXX10
extension=8601
prefix=8601
per_id=<our call id>
```
Inbound calls: `POST /incoming_hangup1` with `phone_number`, `extension`.

### Predictive dialling
| Step | Endpoint | Fields |
|---|---|---|
| Agent joins | `/login_in_queue1` | `extension`, `queue` |
| Dial a customer | `/predictive_call` | `extension`, `prefix`, `queue`, `mobile_no` |
| Agent leaves | `/logout_queue1` | `extension`, `queue` |

### Agent availability
`/queue_paused1` and `/queue_unpaused1` with `extension`.

### After the call: `POST /disposition_api` (JSON)
```json
{
  "extension": "8601",
  "phone_number": "98XXXXXX10",
  "caller_name": "Customer name",
  "disposition": "Contacted",
  "sub_disposition": "PTP",
  "remark": "Agent's notes",
  "callback_datetime": "2026-11-20 11:00",
  "direction": "Outbound"
}
```

### Call records: `POST /cdr_report`
```
start_date=19-11-2026
end_date=19-11-2026
process=Outbound
```

### Recordings: `POST /download_audio/`
```
ids=<CDR id>
```
Returns a ZIP; SamvadX stores the audio in its own private storage.

### Supervisor monitoring: `POST /call_monitor_api`
```
mode=listen | whisper | barge
user_extention=<agent's extension>
monitor_extention=<supervisor's extension>
```

### Creating agents: `POST /users_webhook_api` (JSON)
Name, password, user level (admin / manager / user) and extension.

## Events SkyCRM sends us

Your webhook posts to `https://<company>.samvadx.com/api/telephony/webhook` (secret-protected).

| Field we read | Used for |
|---|---|
| `callid` | matching the event to our call |
| `status` | live state (ringing, answered, ended) |
| `extension`, `phone`, `direction` | which agent and customer |
| `disposition`, `billsec`, `src`, `dst` | the final CDR: answered or not, talk time |

## Agents' voice

Agents call from the SamvadX web page using SkyCRM's WebRTC endpoint, reached through our gateway `voice.samvadx.com` over an IPsec tunnel to your network, with our TURN server relaying audio.
