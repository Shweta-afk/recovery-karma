# SkyCRM meeting guide

Three parts: how to drive Postman, what every API does (with the problem we've seen), and the questions to ask.

---

## Part 1 · Driving Postman

**The screen**
- **Left sidebar → Collections → SamvadX x SkyCRM-ACD**: 10 folders, one per area, numbered like SkyCRM's own document (S1, S2 … = section 1, 2 …).
- **Top right: SkyCRM**: the environment. It holds the values every request uses (`{{extension}}`, `{{customer_number}}` …). Orange `{{...}}` text in a request is a value taken from there.
- **Clicking a request** opens it. Its tabs:
  - **Body**: the fields we send (form fields, or JSON for two of them). This is what he'll want to see.
  - **Authorization**: "Bearer Token" with `{{token}}`. The token is made automatically before each request.
  - **Scripts**: the code that makes the token. You don't need to touch it.
- **Send** (blue button) sends it. The response appears at the bottom:
  - **Body**: SkyCRM's answer.
  - **Test Results**: green "PASS" when SkyCRM's `status` says success.

**One thing to explain to him:** SkyCRM answers HTTP `200 OK` even when it fails. The real result is the `status` inside the body: `200` = success, `300` = failed, `401` = token problem. That's why we check the body, not the HTTP code.

**How the token works (if he asks):** each request carries `Authorization: Bearer <token>`. The token is HS256-signed with the secret SkyCRM gave us and contains `username`, `password`, `extension` and an expiry one hour ahead. A new one is made for every request.

**Changing a value for a demo:** top right, click the eye icon next to "SkyCRM" (or open Environments → SkyCRM), edit the Value, press Cmd+S.

**Safety**
- S1 Click to call and Predictive: dial ONLY your own number; nothing stops other numbers from Postman.
- Create user makes a real user. Logout logs that agent out of SkyCRM.
- Don't open Postman's Console while sharing your screen (it can show the token), and don't show the SkyCRM PDF (their secret is printed in it).

---

## Part 2 · Every API, how to show it, and its known problem

**Rule that applies to all of them:** SkyCRM reads **form fields** only (`x-www-form-urlencoded`). Sending JSON makes every field arrive empty and their server crashes with `'NoneType' object is not subscriptable`. Their document shows JSON examples, so this cost us days. The two exceptions take JSON: `disposition_api` and `users_webhook_api`.

### 01 · Login and logout
| Request | What it does | Show | Known problem |
|---|---|---|---|
| S22 Login | Checks our token is valid | Send it first: proves the secret and token format work | — |
| S25 Logout | Logs a SkyCRM user out | Needs `username` | Only if he asks; logs the agent out |

### 02 · Outbound calling
| Request | What it does | Show | Known problem |
|---|---|---|---|
| S1 Click to call | Rings the agent's extension, then the customer | Body: `phone_number`, `extension`, `prefix` (= extension), `per_id` | No field to choose the **caller ID (DID)**; the number must be plain 10 digits (`+91…` / `0…` reached "NO ANSWER") |
| S2 Call answered | The extension's live state | Response shows `InUse`, `callid`, the number | Says `unavailable` when the softphone isn't registered |
| S3 Hang up | Ends the outbound call | Same fields as S1 | — |

### 03 · Inbound and queues
| Request | What it does | Known problem |
|---|---|---|
| S4 / S5 Register / leave queue | Puts the agent into the inbound queue | Spec says `queue` is a list, examples differ (`'4003,4004'` vs `["8601"]`): which format? |
| S6 / S7 Pause / unpause | Stops/starts inbound calls reaching the agent | — |
| S8 Check incoming | Is a call ringing for this agent | — |
| S9 Incoming hang-up | Ends an inbound call | — |
| S10 Missed calls | Calls that reached nobody | — |

### 04 · Call records and recordings
| Request | What it does | Known problem |
|---|---|---|
| S11 Call records (`cdr_report`) | Every call with duration, ANSWERED/NO ANSWER, recording path | `recordfile` is a path on their private network, not a downloadable link; it doesn't contain the DID |
| S12 Download recording | ZIP of recordings for CDR ids | Their document says `download-audio`, which is a **404**; the working one is `download_audio/`. It answered 500 `host='disk'` until about 12 Nov |

### 05 · Live call controls (agent must be on a call)
| Request | What it does |
|---|---|
| S15 Mute / unmute | `state` yes/no, `direction` in/out/all |
| S16 Hold / resume | `state` yes/no |
| S17 Transfer | To another extension or a mobile |
| S18 Transfer hang-up | Drops the transfer leg |
| S19 Complete / abort / three-way / swap | After a transfer |
| S20 Conference hang-up | Removes a conference member |

Built into our call screen on 16 Nov; not yet confirmed on real calls.

### 06 · Supervisor monitoring
| Request | What it does | Known problem |
|---|---|---|
| S13 Listen / whisper / barge | Supervisor joins an agent's live call | **The supervisor's phone rings, says success, but there is no sound.** Their document doesn't say which field is the agent and which the supervisor; we now send agent = `user_extention`, supervisor = `monitor_extention`. Their note says it works "extension to extension": does it work on calls to customers' mobiles? |
| S14 Stop monitoring | Ends it | — |

### 07 · After the call
| Request | What it does | Known problem |
|---|---|---|
| S23 Disposition | Saves the outcome in SkyCRM | Needs **JSON** (form data answers 400 "Invalid JSON"), unlike every other call. Until 5 Nov none had ever reached them. Only "Contacted" / "Non-Contacted" allowed at the top level |

### 08 · Agent breaks
S24 start/end (`break_events2`). Their list at the end of the document spells it `break_event2`: which is right? Not used by us yet.

### 09 · Predictive dialling
Join queue → `predictive_call` per customer → leave queue. **We have no queue number from them**, so this isn't switched on for any company. Their examples are JSON; we send form fields like everything else.

### 10 · Users
`users_webhook_api` creates a SkyCRM user. **It has no authentication at all**: anyone who knows the URL can create users in our account. Our users were created with process, team and region blank.

### Events they send us (webhook)
Collection overview page → table. Known problems:
- Live status words arrived that their document doesn't list (we treat unknown words as "ringing").
- Their events were not reaching us at all until 4 Nov (webhook URL not set on their side).
- Nothing says **who hung up**, the **DID** used, or (for predictive) which extension finally took the call.
- The outbound "Answered" moment never arrives in a form we can record (our "answered at" is empty on every call).

---

## Part 3 · Questions to ask (most important first)

**Blocking us now**
1. **Listen / Whisper / Barge:** the supervisor's phone rings but is silent. Which field is the supervisor and which the agent? Does monitoring work on calls to outside mobile numbers, or only extension to extension? Do users need process/team set for it to work?
2. **Predictive dialling:** which queue number do we use? Should `queue` be sent as `8601`, `'4003,4004'` or `["8601"]`? Form fields or JSON?
3. **Predictive events:** does the "Answered" event carry the extension that actually took the call? When nobody was free to take an answered call, does the CDR still say ANSWERED?
4. **Caller ID / DIDs:** how do we choose which of our numbers a call goes out on? There's no field in `dialing_phone` or `predictive_call`, and no DID in events or CDRs.

**Data we're missing**
5. Can the end-of-call event or CDR say **who hung up** (agent or customer)?
6. For **inbound** calls, which field carries the number the customer dialled (our DID)?
7. Can every event carry the `callid`, including the first ringing one?
8. Please send the full list of live `status` words your events use.
9. Is there an "Answered" event for outbound calls with a time we can store?

**Recordings**
10. Is `download_audio/` now stable after the `host='disk'` errors? What's the size limit per request?
11. Can `cdr_report` give a direct downloadable link instead of a private-network path?

**Security and setup**
12. **`users_webhook_api` has no authentication.** Please add a token to it.
13. Their secret is printed in the API document we were given. Please **issue us a new secret** and don't put it in documents.
14. Which base URL is ours for production: `samvadx.skycrm.app` or `vs.skycrm.app`?
15. When creating users: what should `process`, `assigned_to` and `user_region` be?

**Document corrections to request**
16. Say that every API takes **form fields**, and that `disposition_api` takes **JSON**.
17. Fix `download-audio` → `download_audio/` and `break_event2` vs `break_events2`.
18. Say that HTTP 200 can carry a failure in `status`.
