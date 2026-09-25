# Electro Clinic app: server setup

What it does: customers book or post problems in the app. The server emails you (with photos/videos attached), WhatsApps you (text + media), emails the customer a confirmation, gives every request a reference (EC-XXXXXX), and lets you reply so the answer shows in the customer's app and arrives as a push notification. Daily news comes from GNews.

## 1. Run it
1. Install Node 18+ on your host (or laptop for testing).
2. `npm install`, then copy `.env.example` to `.env`.
3. Run `node server.js` once. It prints VAPID keys: paste them into `.env`. Run it again.
4. Open http://localhost:3000

## 2. Fill in .env
- **Email:** Google Account > Security > 2-Step Verification on > App passwords > create one > paste as GMAIL_APP_PASSWORD.
- **WhatsApp (Meta Cloud API):** developers.facebook.com > Create app (Business) > add WhatsApp > note the Phone Number ID (WA_PHONE_ID) and a permanent access token (WA_TOKEN). OWNER_WHATSAPP is your number in international format, no plus: 27615205070.
  **Template (so WhatsApp always reaches you, even outside the 24-hour window):** WhatsApp Manager > Message templates > Create. Name `new_request`, category Utility, language English, body exactly:
  `New Electro Clinic request {{1}} from {{2}} ({{3}}). {{4}}. Files: {{5}}. Full details and any photos or videos are in your email.`
  Add sample values when asked and submit. Once approved (usually minutes), set WA_TEMPLATE=new_request and WA_LANG=en in `.env`. Photos/videos are also sent to WhatsApp whenever you have messaged the business number in the last 24 hours. Otherwise they are always in the email. Leave WA_TEMPLATE empty to send plain text instead.
- **News:** free key at gnews.io > GNEWS_KEY. Leave blank to show daily tips instead.
- **ADMIN_KEY:** any long random password.

## 3. Put it online (HTTPS is required for push notifications)
Deploy this folder to Render, Railway, Fly.io or any VPS. Set the same variables in the host's environment settings. Note: `data.json` (requests and subscriptions) lives on the server disk. Use a persistent disk, or ask me to move it to a database.

## 4. Daily use
Open `https://your-site/admin.html`, enter ADMIN_KEY, then either reply to a reference (customer gets a push and an email if they gave one) or notify all customers about offers and news.
iPhone customers only get push notifications after tapping Share > Add to Home Screen.

## 5. Extra features
- **Urgent flag:** customers can mark a request urgent. It shows 🚨 in the email subject and WhatsApp message.
- **No double bookings:** booked time slots are greyed out. SLOT_CAPACITY (default 1) is how many jobs you can take per slot.
- **Reminders:** customers with notifications on get a reminder 24 hours before their appointment (South African time).
- **Admin:** /admin.html lists recent requests. Tap one, choose Answered / Scheduled / Completed / Cancelled and reply. Cancelled frees the time slot.
- **Installable app + share button:** customers can install it to their home screen and share it on WhatsApp.
- **Spam protection:** each IP is limited to 10 requests an hour.

## 6. WhatsApp media templates (photos/videos when you have never messaged the number)
Create two more Utility templates in WhatsApp Manager, each with a media header:
- `request_photo`: Header = Image (upload any sample photo). Body: `Photo for Electro Clinic request {{1}} sent by {{2}}. Please see your email for the full request.` Samples: EC-1A2B3C / Sipho
- `request_video`: same, but Header = Video (upload a short sample MP4).
Then set WA_TEMPLATE_IMAGE=request_photo and WA_TEMPLATE_VIDEO=request_video in `.env`. WhatsApp limits are 5 MB per image and 16 MB per video. The app shrinks photos automatically. Bigger videos stay in the email.

## 7. More features
- **Ask Electro:** an AI helper for safe first-line troubleshooting (needs ANTHROPIC_API_KEY from console.anthropic.com). Leave it blank to switch the helper off.
- **Common-problem buttons** fill in the problem form in one tap.
- **Ratings:** when you mark a job Completed, the customer can rate it 1 to 5 stars and you get an email.
- **Daily summary:** at 07:00 you get an email listing today's bookings.

## 8. Activate Ask Electro (the AI helper)
1. Create an account at console.anthropic.com, add a small amount of credit and set a monthly spend limit.
2. Create an API key and paste it into `.env` as ANTHROPIC_API_KEY. Restart the server. The startup line will say `Ask Electro: ON`.
3. Until a key is added, the helper card is hidden from customers automatically. Each customer question is billed by Anthropic, and each device is limited to 30 questions an hour.
Electro also reads photos (error codes, model labels, damage), understands voice input on supported phones, and replies in the customer's language.

## 9. Business info and banner
In /admin.html, fill in opening hours, areas served, call-out fee and an optional banner notice (for example "Closed 25 Dec"). They show on the app's Home screen and Electro uses them when answering. Leave a field empty to hide it. The admin page also shows total requests, this month's count, requests awaiting reply and your average rating.

## 10. Customer sign-in, referrals and more
- **Sign-in:** customers enter their email and get a 6-digit code (sent from your Gmail). Once signed in they see their full job history on any device and their details are filled in on the forms. Gmail limits how many emails you can send per day, so this suits a small or medium customer base.
- **Referrals:** in /admin.html set a Referral reward (for example "R100 off your next visit"). Signed-in customers get a personal code and a share button. When a friend books with the code and you mark that job Completed, the referrer earns a credit and is emailed. When they use it, enter their email under "Redeem a referral credit". Leave the reward empty to switch referrals off.
- **Cancel booking:** customers can cancel from their job list. You get an email and the time slot is freed.
- **Call me back:** a one-tap callback request on the Home screen.
- **Works offline:** the app opens even without data (useful during load-shedding). Sending requests still needs a connection.

## 11. Brand
The official logo is in `public/logo.jpg` (opening splash screen), `public/logo-emblem.png` (header and admin page) and `public/icon-192.png` / `icon-512.png` (home-screen icon and favicon). To change the logo later, replace these files. Brand colours: navy #111b50, teal #008c95 (buttons use the slightly darker #007f88 so white text stays readable), light-blue gradient #dceff5 to #67c8e8.
