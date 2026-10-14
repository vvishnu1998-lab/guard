# Moving STARNET's guards from TestFlight / preview APK to the store builds (N153)

**DRAFT v2, 2026-10-13: nothing here has been sent to anyone.** v1 went through four independent
read-only reviews (safety against the code, a guard's-eye read of the messages, a fact-check, a
pre-mortem): all four said FIX FIRST, mostly with evidence from the repo. This version folds them in;
the record is at the end. Anything sent to guards is **Tier 2** (`POLICY.md`): Vishnu is present, and
the STARNET admin sends each message to each guard individually. Owner: Vishnu. The by-badge sheet is **NOT in this repo**: the repo is public, and `POLICY.md` allows guard data out
of the database as "guard_id, company_id, badge, counts only". The full sheet (platform, build, schedule,
flags) is `~/guard-private/migration-wave-sheet-2026-10-13.csv` on Vishnu's Mac, and **this document names
no badge** for the same reason. A blank tracking template is committed
(`audits/store-links/migration-wave-sheet-template.csv`).

| date | what |
|---|---|
| **Fri 2026-11-13** | **last supported day to switch.** Guard messages say "Friday, November 13" |
| **Sat 2026-11-14** | internal **act-by**: every guard confirmed, or called personally |
| **Mon 2026-11-16 12:00 PT** | **Plan B decision** for any iPhone guard still unconfirmed (section 7) |
| **Fri 2026-11-27 17:21 PST** | **earliest** lapse of TestFlight build 48 (`EXPIRIES.md` E16). An expired build no longer opens |

## Hard stops: nothing goes to a guard until every line is true

| # | stop | who |
|---|---|---|
| H1 | The iTunes lookup returns 1 for **the storefront the guards use** (N186: today only `us` does), **re-run on each wave day** | me, then re-run per wave |
| H2 | **Android only:** Vishnu has read the Play Console Production status, seen it **published** (not just approved), and installed it from the listing on an Android phone that is **not** a tester | Vishnu |
| H3 | The pilot in section 2 has run, **including the queue-flush steps**, and the wording below is re-checked against what it showed | Vishnu |
| H4 | Vishnu has approved every message below word for word | Vishnu |
| H5 | The admin has confirmed a **current phone number for every badge** on the list (the sheet cannot say who has left) | STARNET admin |
| H6 | The decisions in section 9 (D1 to D4) are made | **DONE 2026-10-14** (Vishnu accepted all four as recommended) |

---

## 1. What this plan rests on, and how sure it is

| fact | source | sure? |
|---|---|---|
| The iOS app is on the App Store: listed as **"Netraops"** (lowercase o), Calvern LLC, **version 1.0.17, released 2026-10-12 17:19:30Z** | public iTunes lookup, 2026-10-12/13 | **yes** |
| It is **available in the US storefront only** today | lookup per storefront: 1 result for `us`, 0 for 11 others (N186) | **yes**; Vishnu is fixing it in App Store Connect (**all territories, not just the 11 checked**) |
| **Google Play: production live, installable, and for which countries** | none | **UNVERIFIED.** `STATE.md` says the vc26 review outcome is UNVERIFIED. **Vishnu reads Play Console before any Android message (H2)** |
| The store build is **probably the same binary as TestFlight build 48**, so a TestFlight phone should see **Open**, not Update | N153 + `app.json` is 1.0.18 since 09-18 while the store lists 1.0.17 | **no**. The Build row on the 1.0.17 version page in App Store Connect settles it. **Do not promise an Update button** |
| Apple documents **no automatic swap** of a TestFlight copy for the store copy | Phase 2 research | **UNVERIFIED** (a negative from research notes). The **pilot** shows the real behaviour |
| TestFlight builds last **90 days from upload**; **EAS created** build 48 at 2026-08-30T01:21:10Z | Apple's tester page; EAS (a creation time, not an upload time) | the date is the **earliest**; read "days remaining" in the TestFlight app |
| **Delete + reinstall** wipes the saved login **and everything unsent**: `authStore.ts` clears the four Keychain keys on a fresh install, and the offline queue and dead letters live in AsyncStorage, which dies with the app | repo read | yes (code); **not yet seen on a device** |
| **The app does NOT show queued items.** `pendingCount` is produced in `offlineStore.ts` and rendered by **no** component. The only on-screen signals are the dead-letter banners ("N ITEMS FAILED TO SEND", "N ITEMS ARE SAVED ONLY ON THIS PHONE", "SAVED DATA COULD NOT BE READ"), a permanent "Unsent items" drawer row, and a one-time alert "NOT SENT YET" when the write is queued | `UnsentWritesBanner.tsx`, `DrawerOverlay.tsx`, `reports/new.tsx:291`, `checkpoints/scan.tsx:408`; grep of `apps/mobile` for `pendingCount` finds no `.tsx` reader (I re-ran it) | **yes** (v1 said the opposite; that was wrong) |
| **The queue is flushed only while the guard is on shift**: `startSync()` runs in `home.tsx` only `if (isOnShift)`, plus one `syncQueue()` right after each enqueue | `home.tsx:370-375`, `offlineStore.ts:129-179` (I re-read it) | **yes**. A report or scan queued late in a shift that ended before it flushed stays on the phone until the next shift |
| A fresh install runs the **embedded** 1.0.17 JavaScript first; the production OTA applies on a **later cold start** | `STATE.md` + expo-updates behaviour | likely; **confirm in the pilot**. Hence "close the app completely, open it once more, **stay on the Home screen about 2 minutes**" |
| `/api/auth` allows **20 requests per 15 minutes per IP**, and it counts **every** `/api/auth` call (sign-in, refresh, forgot-password), not only sign-ins; `trust proxy` is set, so it is per network | `index.ts:78-84`, `:68` | **yes**. The pilot counts one switch's calls from `auth_events` |
| **5 wrong passwords lock the account for 30 minutes, and every further wrong try restarts the 30 minutes**; a wrong password while locked says only "Invalid credentials" | `auth.ts:118-134` (I re-read it); `login_blocked_locked` has fired 4 times in production | **yes** |
| **`RESEND WELCOME` does NOT clear a lock.** It sets a new password, `must_change_password`, and `tokens_not_before` (signs out every phone) | `guards.ts:393-415` (I re-read it) | **yes** |
| The app's **"Forgot password?"** emails a new temporary password, forces a change at next login, **and clears the lock** | `login.tsx:168-171`, `auth.ts:895-919` (I re-read it) | **yes** (the readability reviewer counted 6 STARNET guards using it in 60 days) |
| The app asks for **Notifications first** (when the guard taps Sign In), then Location (foreground, then background) after sign-in. A denied Notifications prompt means **no push device row**. Background-location denial is **silent**: the guard sees nothing | `login.tsx:42`, `_layout.tsx:164-166, 402-406` (the first I re-read) | the order **yes**; exact iOS prompt wording and the Android "Allow all the time" path **UNVERIFIED** (pilot) |
| One guard has **one working phone at a time**: each login revokes the guard's sessions elsewhere and repoints the single push row | `auth.ts`, reviewer read | yes (code); pilot-check with two phones if you can |

**Who is affected** (STARNET, 26 active guards, 2026-10-13; **counts only, the badge lists are in the
private sheet**): **22 iPhones by latest login** (18 on build 48; 4 dormant on build 46, and **one more
guard has a live build-46 iPhone**) and **4 Android**: one on the sideloaded preview APK (that guard also
carries an iPhone), one on the old 1.0.16 runtime with an unknown install route, one on runtime 1.0.18
(a Play build or the preview APK, route unknown; also an iPhone), and one dormant for about 30 days with no
device row and an unknown route. Platform by login is not the whole story: **five badges show both
platforms** in `guard_devices`, and **one more** shows both in its sign-ins over 60 days. **Ask which phone or
phones every one of these carries before any message.** 20 have an active push row; 6 do not. **One badge may
be a shared badge** (about 24 sessions in 14 days, from an Android and one or two iPhones; UNVERIFIED): ask
the admin who uses it **before** any message.

**Reach:** the in-app card reaches **17** (runtime 1.0.17/18, seen in the last 7 days; the sheet's
`channels` column is the rule), a push at most 16. **The admin text reaches every guard the admin has a
current number for (H5)**: that is the primary channel.

---

## 2. The pilot (before any guard is contacted)

Use **your own phones and a Star Guard test-tenant guard account**: never a guard's phone, never a real
guard's account. Creating the test shift is a production write in the test tenant (yours to approve). About
45 minutes for iPhone, 30 for Android. Write the answers in the tables.

### 2A. iPhone

| # | do | write down |
|---|---|---|
| 0 | Confirm the store page is reachable for your Apple ID's storefront (N186). | yes / no |
| 1 | **Before touching anything:** open TestFlight, read NetraOps' **days remaining** and build. Open NetraOps, sign in as the test guard. Tell me the badge: I read `guard_devices.client` (read-only) for the `update/` id, and `auth_events.user_agent` for the build. | days left; build; update id |
| 2 | **Clock in** at a Star Guard test site (a test shift is **required**, not optional). Put the phone in **airplane mode** and submit an activity report. Note exactly what the app shows (expect a one-time **NOT SENT YET** alert and **no persistent indicator**). **Leave it queued.** | what showed, word for word |
| 3 | Restore signal **while still clocked in**. Time how long until the report appears server-side (I read it). Then repeat step 2 and **clock out while an item is still queued**; relaunch the app **off shift** with signal and wait 5 minutes. | seconds to flush on shift; does an off-shift item **ever** flush? (expected: **no**) |
| 4 | In **Safari**, open `https://www.netraops.com/app?src=qa_test`, tap **Available on the App Store**. Do **not** tap anything on the store page. | the exact button: **Open / Update / Get / Install / not available**; the title shown (**Netraops?**). Screenshot |
| 5 | If it says **Open**: tap it. Which app opens: the TestFlight copy? | what opened. This is what a careless guard would do |
| 6 | Delete the TestFlight app: hold the icon, **Remove App, Delete App, then the third tap "Delete"**. Note the menu words on your iOS version (and the "Remove from Home Screen" trap). Does TestFlight still list NetraOps? Is there an orange dot on the icon of the TestFlight copy before you delete it? | the exact menu words (screenshot); yes / no; orange dot yes / no |
| 7 | Back on the store page: expect **Get**. Tap it. | button; any Apple ID or region message |
| 8 | Open the new app. Sign in as the test guard. | **which prompts, in what order**; the exact buttons offered for Location (is there an Always button, or "Change to Always Allow" later?) |
| 9 | Settings: **Location (Always? Precise?)**, **Notifications**. | the states |
| 10 | **Close the app completely** and open it once more; stay on Home for 2 minutes. I read `guard_devices.client` again. | the new update id: expect the **production 1.0.17** group within one or two launches; is `update/embedded` gone? |
| 11 | Was the item from step 2 / 3 still there after the reinstall? | yes / no (expected: **gone**; that is why the gate exists) |
| 12 | Count the `/api/auth` calls the whole switch made (`auth_events`, I read them). | N calls (this sets the per-network cap) |
| 13 | Still clocked in at the test site (or a new test shift): watch for a ping within 30 minutes. | ping arrived? geofence registered? |

### 2B. Android (H2 first; skip until Play is verified)

Same steps on your own or a spare Android phone **installed from the Play listing** (not a tester
build): uninstall path and menu words, the Play button, sign-in, the prompt order, and **whether
"Allow all the time" is a prompt or a Settings page** on that Android version. If you have no Android
phone, **no Android wave starts**; tell me and you decide.

### What the pilot decides

| step 4 showed | meaning | the guard message is |
|---|---|---|
| **Open** (expected) | the store build is the TestFlight build; nothing to update to | **A1 then A2** (delete first) |
| **Update**, and tapping it kept the login and the queued item | an in-place switch works | **B**. Then repeat once on a second iOS version if you can |
| **Get** without a TestFlight copy being detected | the same as Open in practice | **A1 then A2** |
| **not available** | the storefront is still US-only | **stop**. N186 first (H1) |

| step 3 showed | meaning |
|---|---|
| an off-shift item **never** flushes (expected) | the READY check in A1/C1 and the "clock in once with signal" rule stand (section 3) |
| an off-shift item **does** flush on relaunch | say so; the check can be relaxed, Vishnu decides |

---

## 3. The safe-to-switch gate

A delete cannot be undone and destroys anything unsent. Two halves: the **admin's checks**, which the
guard cannot do, and the **guard's READY check** inside the first message.

### 3A. The admin's checks, at send time and again when the guard says "starting"

1. **No open session, open break, or pending swap/handoff** for that badge. Run this read-only (`postgres-readonly`, badges only); **any row means do not start**. Guards often do not clock out, and the server closes the session later, so a schedule is not enough:

```sql
SELECT 'open_session' AS kind, g.badge_number FROM shift_sessions ss JOIN guards g ON g.id = ss.guard_id
 WHERE g.company_id = '27c4d404-8769-49ca-bfd6-93cb9b890067' AND ss.clocked_out_at IS NULL
UNION ALL
SELECT 'open_break', g.badge_number FROM break_sessions b JOIN guards g ON g.id = b.guard_id
 WHERE g.company_id = '27c4d404-8769-49ca-bfd6-93cb9b890067' AND b.break_end IS NULL
UNION ALL
SELECT 'pending_swap', g.badge_number FROM shift_swap_requests s JOIN guards g ON g.id IN (s.from_guard_id, s.to_guard_id)
 WHERE g.company_id = '27c4d404-8769-49ca-bfd6-93cb9b890067' AND s.status = 'pending'
ORDER BY 1, 2;
```

2. **A window, not a time of day.** Cut each day's cohort **the evening before** from the **live** schedule: guards with a gap of **at least 8 hours** the next day (4 hours of margin plus sleep), **up to 5**, the rest roll forward. Each text states that guard's own window ("Friday between 10:00 and 13:00") and the admin **adds no shift for that guard inside it**. The sheet's schedule columns are a **2026-10-13 snapshot and only 7 of 26 guards have any shift ahead** (57 shifts, to 10-28): **a blank is not "free"**. (The pre-mortem reviewer counted 43% of the last 30 days' shifts created under 24 hours before they start.)
3. **Not the night before a shift** unless the guard has confirmed the password (below).
4. **No more than 3 guards on one network in 15 minutes** (2 if a recovery is likely), **never as a group at an office, and not on a site's Wi-Fi while someone there is on shift**: the budget is for every `/api/auth` call, and a 429 can hit **after** the guard has deleted the app and can also hit an on-shift guard on the same network. Prefer home or mobile data; stagger.
5. **H1** re-run on the wave day (iPhone) / **H2** (Android).
6. **One phone at a time.** A guard has one working phone: pick the one they carry on shift, finish on it, and tell them the other phone signs out; do not alternate. Both-phone guards: iPhone first.
7. **Ask first** for the both-platform badges and the badges whose install route is unknown (the sheet's `ASK` rows): "Which phone or phones do you carry for work? Did someone send you a file to install NetraOps, or did you get it from the App Store or Google Play?" A **Google Play** answer on Android means **no switch needed** (and check whether they are on the **internal track**, section 7).
8. **Dead letters.** **Two badges (3 items between them; the sheet flags them)** have items the phone reported to the server; their warning banner **stays until dismissed**, so "no warning box" cannot be literal for them. For them: open the drawer, tap **Unsent items**, and **every row must say "Your supervisor's team has a record of this"**. Any row that says **"Not yet reported"**, or a banner that says **"SAVED DATA COULD NOT BE READ"**: **do not delete; tell Vishnu**. (Deleting the app bypasses the app's own refusal to delete an unreported item; reported ones are only on the phone.)
9. **Build-46 and 1.0.16-runtime guards** may not have these banners at all (UNVERIFIED): confirm by phone before they delete.

### 3B. The guard's READY check (in A1 / C1; the guard replies READY, then the admin sends the steps)

- They **know their NetraOps password and can open the email address they sign in with, on this phone** (recovery is emailed, and it can land in **Junk/Spam**: see section 4).
- They **had signal for every report, scan and task at their last shift**. If not sure, they **clock in once on their next shift with signal and stay for 2 minutes** (that is the only thing that flushes the queue), **then** switch.
- **No warning box on the Home screen.**
- **Off shift, and the next shift is 4 hours or more away.** An **unfinished report** means **do not switch today** (an off-shift guard cannot send it, and drafts are not saved).

**Password.** Most guards have not typed it recently (the readability reviewer counted 13 of 26 with no `login_success` in the last 14 days; a token refresh keeps them signed in). The only way to test it is to sign out and in on the **old** app, which costs requests and strands a guard who fails. So: a guard who is **not sure** replies **NOT SURE** and the admin **calls**: on the **old** app the guard **signs out**, taps **Forgot password?** on the sign-in screen, opens the emailed temporary password, signs in with it and sets a new one, **before any delete** (a few `/api/auth` calls; the pilot counts them, and they count against the network cap).

### 3C. After the switch (the guard reads these back; the admin does not tick without them)

A reinstall resets permissions. **A guard who looks switched but has location off is not tracked**, and nothing tells the guard (background-location denial is silent, a denied Notifications prompt means no push row). **Done means the guard has told the admin**: the app is open on their account; **Settings > NetraOps > Location says "Always"** with **Precise Location on**; **Notifications are On**; and (iPhone) **TestFlight no longer lists NetraOps**. Then section 6.

---

## 4. The messages (the admin sends each one individually; Vishnu approves the wording first)

**Format rules:** plain ASCII only (one en dash or curly quote turns an SMS into about twice as many parts, and long texts arrive split or reordered), no `**`, **each URL alone on its own line**, send on **iMessage or WhatsApp** where the guard uses it, or as **one text per numbered step group** on plain SMS. Sent **from the admin's own number the guard already knows, by name, to one guard at a time**. Every message says who it is from, says "I will never ask you for your password", and gives a way to reply. The link opens a **web page, not the store**: the messages say to tap the button on it.

The one link is `https://www.netraops.com/app?src=migrate_admin` (the tag is in the registry and counts as "migrate"). **iPhone messages name only the App Store; Android messages name only Google Play.** **D3:** these drafts use the word **TestFlight** in the iPhone texts (guards were told "TestFlight" before; Apple's 2.3.10 covers the iOS app and its metadata, not an admin's text). Keep 2.3.10 for in-app screens. If you say no, A1 becomes "The copy on your iPhone is a test copy and stops opening in late November" and A2 step 2 drops "Do not reinstall from TestFlight."

### Message A1: iPhone, the check (send first; no delete yet)

```
Hi, it's [admin] from STARNET. NetraOps is now in the App Store. The copy on your iPhone came from TestFlight and stops opening in late November, so please switch by Friday, November 13. It takes about 10 minutes.

Do this on [day] between [HH:MM] and [HH:MM] ONLY. If you are on shift or on a break, do nothing.

DO NOT DELETE ANYTHING YET. Reply READY when ALL of these are true:
- You know your NetraOps password and can open your email on this phone (look in Junk or Spam too). (Not sure of the password? Reply NOT SURE and I will call you before you delete anything.)
- You had signal for every report, scan and task at your last shift.
- No warning box shows on the NetraOps Home screen.
- You are off shift, and your next shift is 4 or more hours away. No unfinished report.

If you also use an Android phone, tell me: it needs its own switch.
If one is not true, reply with which one and I will help. I will never ask you for your password.
```

### Message A2: iPhone, the steps (send only after READY **and** the admin's checks in 3A)

```
Good, let's switch NetraOps now. Keep this text: you need the link again in step 3. Do the steps IN ORDER. If anything looks different from what I wrote, STOP and text me.

1. Tap this link:
https://www.netraops.com/app?src=migrate_admin
Tap Available on the App Store. Check that you see NetraOps by Calvern LLC (it may show as Netraops) and a button. If the button says Open, that is your OLD copy: do NOT tap it. Do NOT tap the button yet. If you see "not available" or anything else, STOP and text me. Do not delete anything.
2. Go to your Home Screen. Press and hold the NetraOps icon. Tap Remove App, then Delete App, then Delete. Do not pick "Remove from Home Screen". Do not reinstall from TestFlight.
3. Tap my link again, tap Available on the App Store, then tap Get. If Apple asks for your Apple ID password or Face ID, that is Apple, not NetraOps.
4. Tap Open. Sign in with your email and the NetraOps password you use now. Type it only in the app, never on a website. When your phone asks, tap Allow for Notifications. For Location tap Allow While Using App. If it asks again, tap Change to Always Allow. Then open Settings, NetraOps, Location, and check it says Always and Precise Location is on.
5. Close NetraOps completely: swipe up from the bottom edge, pause, then swipe the NetraOps card up (with a Home button, press it twice). Open NetraOps once more and stay on the Home screen for 2 minutes.
6. Text me DONE, and tell me: Location says Always (yes/no), Notifications are On (yes/no), and TestFlight no longer lists NetraOps (yes/no).

Sign-in not working? Stop after 2 tries, then tap Forgot password? or text me. 5 wrong tries lock you out for 30 minutes.
```

### Message B: iPhone, tap Update (only if the pilot proved it; same A1 READY check first, minus the delete line)

```
Hi, it's [admin] from STARNET. NetraOps has a new version in the App Store. Please update by Friday, November 13, when you are off shift (reply READY first, using the same four checks as my earlier text).

1. Tap this link:
https://www.netraops.com/app?src=migrate_admin
2. Tap Available on the App Store.
3. If the button says Update, tap it. If it says anything else (Open, Get or not available), STOP and text me.
4. When it finishes, open NetraOps, close it completely, open it once more, and stay on the Home screen for 2 minutes.
5. Text me DONE.

I will never ask you for your password.
```

### Message C1: Android, the check (send first; **only after H2**)

```
Hi, it's [admin] from STARNET. The NetraOps on your Android phone was installed from a file. Please switch to the Google Play version by Friday, November 13. It updates itself and it is the one we support. It takes about 10 minutes.

Do this on [day] between [HH:MM] and [HH:MM] ONLY. If you are on shift or on a break, do nothing.

DO NOT UNINSTALL ANYTHING YET. Reply READY when ALL of these are true:
- You know your NetraOps password and can open your email on this phone (look in Junk or Spam too). (Not sure of the password? Reply NOT SURE and I will call you before you delete anything.)
- You had signal for every report, scan and task at your last shift.
- No warning box shows on the NetraOps Home screen.
- You are off shift, and your next shift is 4 or more hours away. No unfinished report.

If you also use an iPhone, tell me: it needs its own switch.
If one is not true, reply with which one and I will help. I will never ask you for your password.
```

### Message C2: Android, the steps (send only after READY **and** 3A; wording re-checked against pilot 2B)

```
Good, let's switch NetraOps now. Keep this text: you need the link again in step 3. Do the steps IN ORDER. If anything looks different from what I wrote, STOP and text me.

1. Tap this link:
https://www.netraops.com/app?src=migrate_admin
Tap Available on Google Play. Check that you see NetraOps by Calvern LLC and a button (it may say Install, Update or Open). Do NOT tap the button yet. If the button says Update or Open, STOP and text me: do not uninstall. If you see "not found" or anything else, STOP and text me.
2. Press and hold the NetraOps icon. Tap Uninstall (on some phones: App info, then Uninstall), then OK. Do not tap "Remove": that only hides the icon. Can't find Uninstall? Go to Settings, Apps, NetraOps, Uninstall.
3. Tap my link again, tap Available on Google Play, then tap Install, then Open.
4. Sign in with your email and the NetraOps password you use now. Type it only in the app, never on a website. When your phone asks, tap Allow for Notifications. For Location tap While using the app. If a Settings screen opens, tap Allow all the time. Then check Settings, Apps, NetraOps, Permissions, Location says Allow all the time.
5. Close NetraOps completely: open your recent apps and swipe NetraOps away. Open NetraOps once more and stay on the Home screen for 2 minutes.
6. Text me DONE, and tell me: Location says Allow all the time (yes/no), Notifications are On (yes/no).

Sign-in not working? Stop after 2 tries, then tap Forgot password? or text me. 5 wrong tries lock you out for 30 minutes.
```

(The Update/Open stop in step 1 matters: a guard on the Play **internal track** gets the **internal** build back, not Production, and a guard who already has the Play app needs no switch. One of the unknown-route Android guards may be one.)

### Reminder (about a week before the date; to everyone not yet confirmed; no link, so the rules in the first message are read again)

```
Reminder from [admin] at STARNET: please switch NetraOps by Friday, November 13. The steps are in my earlier text. Do them in order, and never while you are on shift. If you want help, reply HELP and I will call you. If you can't find my earlier text, reply and I will send it again.
```

### Call script (for anyone unconfirmed on Mon Nov 2 and Mon Nov 9; for the dormant badges)

1. "Hi [first name], it's [admin] from STARNET. I'm calling about the NetraOps app on your phone. Do you have 10 minutes? Are you at work or driving right now?" If yes to either, end politely and call back.
2. "Are you still working with us, and is this still your number?" If no, tell Vishnu; the badge comes off the list.
3. "Which phone or phones do you use for work: iPhone, Android, or both?" Both means **one phone at a time, iPhone first**, and the other signs out.
4. Ask the **READY questions** out loud (the four bullets in A1). Any "no": stop, fix it, book another time. **Delete nothing on this call unless all four are yes.**
5. Read A2 (or C2) **one step at a time** and wait for each. Say: "Don't say your password out loud. Just type it."
6. Stay on the line until they are signed in and have answered the permission prompts. Ask them to **read back** the three settings (Location Always, Notifications On, TestFlight gone) and, if they can, text you a screenshot of the Home screen. Tick the sheet only then.

### When the sign-in fails (the admin's table)

| the guard sees | it means | do |
|---|---|---|
| **Account Locked** ("Too many failed attempts. Try again in 30 minutes or contact your supervisor.") | 5 wrong tries. **Every further wrong try restarts the 30 minutes** | **stop typing.** It opens by itself 30 minutes after the **last** try, or the guard taps **Forgot password?** on the sign-in screen: it emails a new temporary password, **clears the lock**, and the app asks for a new password. Count wrong tries **from the last successful sign-in**, not per sitting |
| **Login Failed / Invalid credentials** | a wrong email or password. **This is also what a locked guard sees after another wrong try** | stop after 2; Forgot password? |
| **Login Failed / "Too many login attempts, please try again later."** | **the network budget** (20 per 15 minutes), not the password | wait **15 minutes**, try **once**, or turn Wi-Fi off and use mobile data. **Do not RESEND WELCOME** |
| the guard **cannot open the email** on the phone | Forgot password? cannot help | fix the email first. Then the admin presses **RESEND WELCOME for that one guard only** (it emails a temporary password **and signs them out everywhere**, so **never** while the guard has another phone signed in or is on shift). A **locked** guard with no email access: Vishnu calls `admin/unlock-guard` (primary admin API route, no UI; **Tier 2**) |

**Check Junk/Spam.** Email from NetraOps (the welcome, and the temporary password that **Forgot password?** sends) can land in Junk or Spam: Outlook put a first welcome in Junk on 2026-10-13. Tell every guard to **look in Junk/Spam** and mark it **Not junk**, and that line is in the READY check (3B, A1, C1).

---

## 5. Waves and dates

The wave labels in the sheet are **a first cut**: the cohort is **re-cut each evening** from the live schedule (3A.2), and "three waves in three days" is a **target, not a promise**.

| wave | who (badges in the sheet) | how | when |
|---|---|---|---|
| **Pilot** | Vishnu's phones, a Star Guard test guard | section 2 | this week |
| **1A, 1B, 1C** | 15 iPhone guards on build 48, active in the last 3 days (5 each; each guard's sessions in the last 14 days are in the private sheet) | A1, then A2 (or B); admin text; per-guard window | **Mon 10-19 to Wed 10-21**, rolling forward as the evening cut decides |
| **2** | 3 iPhone guards on build 48 quiet 9 to 14 days (one of them may carry an Android phone) | a **call**: the in-app card and push cannot reach them until they open the app | by Fri 10-30 |
| **3** | 4 dormant iPhones on **build 46** (**runtime 1.0.16: no OTA, no card**), **plus the live build-46 iPhone of a both-platform guard**. Their TestFlight build is older and may lapse **before** build 48 (**about Tue 11-17, UNVERIFIED**) | ask the admin if they still work for STARNET; if yes, a **call**. **Read "days remaining" in TestFlight on each phone: any iPhone with fewer than 35 days left joins wave 1**, and **Fri 11-13 is the real deadline for build 46/47** | by Fri 10-30 |
| **Android** | 4 guards, by badge (**H2 first**) | **ask first**; then C1 then C2 where the route is a file; the sideload guard by a call | by Fri 10-30 |
| In-app card | guards on runtime 1.0.17 / 1.0.18 who open the app | an OTA (separate PR), **only after the pilot**, never during a shift; a bonus that reaches **17** of 26 | from about **Mon 10-26** |
| One push | guards with an active push row, seen in the last 9 days (about 16) | Tier 2, Vishnu present, skip anyone on shift | **Mon 11-02** |
| Reviews | everyone unconfirmed | calls (section 4): **Mon 11-02** and **Mon 11-09** (a week of room to roll forward) | Mon 11-02, Mon 11-09 |
| Last supported day | | | **Fri 11-13**; **Sat 11-14** act-by; **Mon 11-16 12:00 PT** Plan B |

Calendar traps: DST ends **Sun 11-01**; **Thu 11-26 is Thanksgiving**, the day before the earliest lapse. Do not leave anyone for the last week.

---

## 6. Tracking: the hand list is the record; the database is a cross-check

The admin ticks the sheet's `done`, `date` and `confirmed_by` columns **only after the guard's read-back** (3C): the app open on their account, Location Always, Notifications On, and (iPhone) TestFlight no longer lists NetraOps. Record in `confirmed_by` that the read-back happened. **"I saw the app open" is not enough:** a guard who taps **Open** on the store page launches the **old TestFlight copy**, signs in, and looks done; that copy stops opening on 11-27 or later, in Thanksgiving week, for every ticked-done guard at once.

TestFlight cannot name who has moved (public-link joiners show as anonymous). **If the store binary is build 48** (open question 1), both installs send the same client header and the same user agent build, so nothing in the system proves a switch by itself; if the Build row says otherwise, `auth_events.user_agent` tells them apart (the pilot records it). After each wave Vishnu can run this **read-only** cross-check (`postgres-readonly`, **booleans per badge**, no timestamps, within `POLICY.md`). **`login_success` alone is worthless** (a logout and login trips it), a ping alone proves nothing about the switch (guards ping on the old app too); the claim is **supporting evidence**, and a re-login also sets it:

```sql
-- Replace <WAVE_UTC>.
SELECT g.badge_number,
       EXISTS (SELECT 1 FROM guard_devices d WHERE d.guard_id = g.id AND d.claimed_at > '<WAVE_UTC>') AS device_claimed_after,
       EXISTS (SELECT 1 FROM location_pings p WHERE p.guard_id = g.id AND p.pinged_at > '<WAVE_UTC>') AS pinged_after
FROM guards g
WHERE g.company_id = '27c4d404-8769-49ca-bfd6-93cb9b890067' AND g.is_active
ORDER BY g.badge_number;
```

A guard who is "done" but has **no device claim** after the wave is not done. **Before the guard's next shift**, read `guard_devices.client` and `last_seen_at` for them and require it is **not `update/embedded`** (the first launch runs the embedded JavaScript; the OTA arrives on a later cold start). **After the guard's first shift following the switch**, count that session's pings against the missed windows (counts only); **below about 60% (a working threshold, not a measured one), call the same day**: a guard with location or notifications off is invisible, and STARNET's own client sees it first in the 09:00 daily report (PINGS tile, GEOFENCE VIOLATION hours). A guard with Notifications denied has no push row (two guards today).

---

## 7. TestFlight and Play housekeeping

- **Never press "Expire Build" on build 48.** It is the fallback, and it lapses by itself. Treat a manual expiry as the lapse.
- **Keep the Public Beta link and the testers until every guard is confirmed.** Closing the link first would strand a guard who needs to fall back; the effect of closing it on guards who already joined is undocumented (confirm on the pilot phone). The welcome email stopped sending new guards to TestFlight with **#109: live since 2026-10-13 15:53 PT** (`/health` shows `14413dd`); the **real path** (a created guard) is still Vishnu's pending test.
- Remove TestFlight testers **only after each guard confirms**: removal does not uninstall their copy, it only stops new builds.
- **Play:** in Play Console, read the Production release (**published**, countries), the internal track's version code and tester list, and compare the app signing certificate with `eas credentials` (this decides whether a sideloaded APK could ever update in place; the plan assumes **no**). **Guards on the internal track who have not been removed keep getting the internal build, not Production.**
- **Plan B (iPhone):** by **Mon 11-16 12:00 PT**, any iPhone guard still unconfirmed (for example a non-US Apple ID that cannot get the store app) means **Vishnu decides on a new TestFlight upload** (Tier 2; a new upload resets the 90 days). Do not let it first come up on 11-26.
- Add nothing to `FREEZES.md` for this: no new submission is involved.

## 8. Never

- **`RESEND WELCOME` as a reminder, an announcement, or the fix for a lock** (it rotates the password, signs the guard out everywhere, and does **not** clear a lock).
- A **group message**, or a **group session at an office**: each guard gets their own, from the admin.
- Starting while a guard is **on shift or on a break**, or inside 4 hours of the next shift.
- **"Expire Build"** on build 48.
- Telling guards to **search the store by name** ("Netraops" and "NetraOps" differ in case, and an unrelated app has a similar name): send the link.
- Linking or sending an **APK**.
- Asking a guard for their **password**, or saying it out loud on a call.
- Deleting the app while a guard has an item the **Unsent items** screen says is **"Not yet reported"**.

## 9. Decisions (Vishnu) and open questions

**D1 to D4 were DECIDED on 2026-10-14: Vishnu accepted all four recommendations as written.** What each means now:

**D1. The queue. DECIDED: route (b), the human gate (3B) plus the pilot's flush test; nothing is built for wave 1.** The OTA banner (a) is built into M1 (`batch/mobile-19`: foreground sync plus a persistent "N waiting to send" banner from `pendingCount`) and **does not gate the waves** unless the pilot shows items are actually lost. The app shows no queued items and flushes only on shift (section 1). Two routes. **(b), my recommendation: the human gate above** (3B) plus the pilot's flush test, which needs nothing built. **(a)** an OTA to runtime 1.0.17 and 1.0.18 before wave 1 that syncs on foreground and shows a persistent "N waiting to send" banner from `pendingCount`; it removes the guesswork but is mobile work on `batch/mobile-19` (you run EAS) and moves the in-app card from about 10-26 to before 10-19. I would build (a) into M1 anyway and **not gate wave 1 on it** unless the pilot shows items are actually lost.
**D2. The /app page says "temporary password". DECIDED and DONE in its own web PR (2026-10-14): the page now says "New to NetraOps? Use the temporary password from your admin; ... Already have an account? Use your own password.", `check:app-page` pins it, and message A2 no longer says to ignore the line (re-read the live page before sending).** The page tells a returning guard to sign in with "the email and temporary password your company admin gave you"; the messages say "the password you use now". A guard who follows the page types an old temporary password and can lock the account. Until it is fixed the messages tell the guard to ignore that line. **Recommendation: a one-line copy change** ("New to NetraOps? Use the temporary password from your admin. Already have an account? Use your own password.") **in the next web PR** (the badge follow-up or W2).
**D3. The word "TestFlight"** in iPhone admin texts (section 4). **DECIDED: yes, A1 and A2 keep it.**
**D4. The reporting columns. DECIDED: as recommended.** The private sheet has `sessions_last_14d` (a count) and `message`. Per-guard usual start hours were left out: that is more than `POLICY.md` allows without your yes, and the evening cut from the live schedule does the job. **The sheet itself is private** (see the top of this document).

Open questions:
1. App Store Connect: the **Build row** on the 1.0.17 version page (expected 48), the **exact TestFlight expiry**, and when territory availability is fixed (N186; all territories).
2. Play Console: the Production status and countries, the internal track's version code and testers, the signing-certificate comparison (H2).
3. **Who uses the possibly shared badge**, and how many phones? The unknown-route Android badges: how did they install? The quiet badge with mostly Android sign-ins: did they move to an iPhone (N115)?
4. The four dormant build-46 guards: still working for STARNET?
5. Whom does STARNET want as the sender and the contact in the messages (`[admin]`), and does the admin hold a current number for every badge (H5)?
6. Do you have an Android phone for pilot 2B?

---

## Review record (2026-10-13)

Four independent read-only reviewers (safety against the code, a guard's-eye read, a fact-check with database recounts, a pre-mortem) returned FIX FIRST on v1 with 4 BLOCKER, 14 HIGH/MEDIUM-high and about 40 MEDIUM/LOW findings. What changed:

- **The data-loss control did not exist** (BLOCKER, two reviewers): the app shows no queued-item notice and flushes only on shift. v1's gate item and both messages relied on it. Replaced by 3B/3C, the pilot's flush test, the dead-letter rule, and D1. I re-ran the grep and re-read `home.tsx` myself.
- **Android uninstalled before checking Play** (BLOCKER): C became C1/C2 with a store check, H2, and an Android pilot.
- **The /app link is a web page, not the store**, so "check it shows NetraOps by Calvern LLC" and "tap Get" could not be done as written: every message now says to tap the store button first. The page's temporary-password line is D2.
- **Recovery**: `RESEND WELCOME` does not clear a lock; "Forgot password?" does and v1 never mentioned it. The recovery table replaces v1's one paragraph.
- **Proof of a switch** was satisfiable by the old TestFlight copy: read-back, claim-based cross-check, a not-embedded check.
- **Schedule**: the sheet's schedule columns see 7 of 26 guards; per-guard windows, the evening cut, the open-session query.
- Also: per-network cap lowered; password pre-step; permission order and exact buttons; one phone at a time; the six both-platform badges; a live build-46 iPhone and a possible shared badge; Nov 13 in guard texts; the in-app card figure is 17; the SQL returns booleans (POLICY); "EAS created" not "finished"; message format (ASCII, one URL per line, anti-smishing lines); Plan B; the Public Beta link stays open.
- **Not adopted as written:** the reviewers' extra per-guard schedule columns (usual start hour, average length): D4. **And after a second review the whole by-badge sheet came out of the repo** (public repo, `POLICY.md`): the committed template has columns only. The reviewers' Sentry tag for geofence registration is **not** used (I did not verify the tag name).
- Facts the reviewers confirmed correct: every fleet count, wave size, day count and date the fact-checker rechecked, every v1 sheet row against the database at 16:03 PT, the auth limiter and `trust proxy`, the fresh-install wipe, and the dates.
