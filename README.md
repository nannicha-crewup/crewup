# CrewUp — public trial version

Standalone Node + SQLite app (no npm dependencies). Data lives in `crewup.db`
and survives restarts. Start with `./start.sh`, stop with `./stop.sh`.
The public link is a free Cloudflare Tunnel (`trycloudflare.com`, no account).
It changes every time the tunnel restarts, and killing the tunnel revokes it
instantly. The app also has an in-app kill switch (owner area).

## First-time setup (owner — do this BEFORE staff try it)

1. Open the public URL on your own phone.
2. Owner PIN: at the bottom of the login screen, leave role = `owner`, enter a
   PIN (4+ digits) and tap **Set PIN**. This is the ONLY PIN that can see money.
   Change it anytime in the owner area (needs the current owner PIN).
3. Admin PINs (up to 3 named admins): in the owner area → Admins → enter a
   name and a PIN → Add admin. Each admin logs in with their own name + PIN
   and can schedule only — money endpoints reject every admin PIN, and the
   activity log records which admin did what (e.g. `admin:Somchai`).
   Deactivate an admin in the same list to block them instantly.
4. **Staff phone numbers (required):** enter the owner area with the owner PIN
   → Staff directory → type each staff member's mobile number next to their
   name → Save phone. Staff CANNOT open the app until their name + phone are
   registered. The 24 names are pre-seeded (Ariel, Bell, Celine, Chloe, Gift,
   Ivy, Janice, Jaslyn, Jay, Jee, KK, Kate, Koiz, Namwan, Natty, Nicha, Nonney,
   Oil, Pear, Phinya, Ploy, Rene, Scarlett, Venus).
5. Rates are pre-seeded: agent $45 all shops; Bae's worker $30, Milli $35,
   Bungalow $35 (agent adjustable 35–45, worker 25–45, backdatable with an
   effective date in the owner area).

## Bae's shop rules (built in)

- Open Wed–Sat only, Tanjong Pagar. Hours 11pm–3am Wed–Fri, 11pm–4am Sat and
  public-holiday eve. Scheduling a Bae's shift on Sun–Tue is refused (unless
  forced); shift times default to 23:00–03:00 / 23:00–04:00 automatically.
  Public-holiday eves are pre-seeded (7 Nov, 24 Dec, 31 Dec 2026) and the
  owner can add more in the owner area.
- Taxi home: reimbursed max **$20/head with receipt**. On clock-out the app
  warns when the per-head amount exceeds $20 (amount ÷ heads, heads = rider
  + people riding along) and when no receipt was attached; the owner summary
  and the BNG bill cap the claimable amount at $20/head, with the warning
  listed in the summary and in the monthly .xlsx Taxi sheets.
- Company transport (0.5–1h after close) can be chosen instead of a taxi on
  clock-out; the taxi amount is then $0 and the departure time is recorded.

## How staff use it (their own phones)

1. Open the public link, enter **your name + mobile number** exactly as the
   owner registered them. Wrong name/phone = no access at all.
2. Tap **Send OTP**. A 6-digit code is generated (valid 10 minutes).
   **Trial: no real SMS is sent.** The owner sees the code in the owner area
   ("Trial OTP codes") and sends it to the staff member (e.g. WhatsApp).
3. Enter the OTP to unlock the app. After the first verification the device is
   remembered for 30 days, so the staff member does not need a new OTP every
   day. If the device is lost, the phone is removed, or the name is
   deactivated, the remembered device stops working and OTP is required again.
4. Pick a shop, take a photo, clock in. Clock out with taxi amount, who paid,
   receipt number/photo and riders. Group clock-in: tick "group mode" and pick
   2–3 people (you must be one of them), one group photo.
5. Staff see only their own hours and taxi — never pay or rates.

## Blocking someone (no link change needed)

- Owner area → Staff directory → **Deactivate (block)** next to the name, or
  delete their phone number. They are locked out instantly.
- If the link leaks: owner area → **Disable public link**. Nobody can open the
  app until the owner re-enables it. Restarting the tunnel also gives a new URL.
- Owner area → **App access history** shows who entered the app and when
  (logins, clock in/out, availability, scheduling, PIN changes, rate changes).

## Features

Clock in/out with photo, group clock-in, replacement cover (who covers whom),
taxi amount + payer + receipt no./photo + riders, availability 3 months ahead,
find-a-replacement, staffing shortage alerts, today's live status, move staff
to another shop (transfer history kept), retroactive rates with effective
dates, backdated shift entry, Thai/English toggle, bill exports (Nicha direct
bill Date/Timing/Hr/1.5/Total CSV; BNG per-shop bill CSV), and a monthly Excel
backup (.xlsx, owner only) with sheets split by shop and data type.
Staff login is OTP: name + registered phone → 6-digit code, valid 10 minutes
(trial: no real SMS — the owner sees the code in the owner area and sends it
to the staff member, e.g. WhatsApp); the device is remembered for 30 days
after the first verification. Up to 3 named admins, each with their own PIN,
schedule-only, and the activity log shows which admin did what.

## Trial limits (be honest about these)

- The free tunnel URL only works while this VM and the tunnel process are
  running. If the VM restarts, run `./start.sh` again and send staff the NEW
  URL (the old one stops working).
- Photos are stored compressed in the database; very large photo volumes will
  grow `crewup.db`.
- This is a trial build, not a production deployment: no HTTPS certificate of
  its own (Cloudflare provides the https link), no per-staff password beyond
  name+phone, and no automated backups — use the monthly .xlsx export.
