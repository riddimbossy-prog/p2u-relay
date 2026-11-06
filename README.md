# p2u-relay
Public booking-code lookup + live scores for predict2u.com.

GET /health, GET /code/:book/:code (sportybet, footballcom, msport, betika, betpawa), GET /events?ids=sr:match:...

## Private live admin analytics

- Owner console: `/admin` (session-cookie login, 12-hour expiry).
- Public first-party tracker: `POST /analytics/collect` from predict2u.com.
- Authenticated metrics: `GET /admin/metrics`, refreshed by the UI every 10 seconds.
- Shows online sessions (5 minutes), visits/minute (60 minutes), unique visitors today, top pages, referrers, devices and unlock clicks. Today uses Africa/Accra (GMT).
- `ADMIN_EMAIL` defaults to `predict2u@gmail.com`; `ADMIN_PASSWORD_SHA256` stores only the password verifier hash (preferred), or `ADMIN_PASSWORD` can be set directly as a Render secret. Do not commit or log it.
- Events are stored in Render Key Value (`REDIS_URL`) so they survive free-web-service sleep and deploys. They are kept for at most 48 hours in the dashboard rollup, with a 50,000 event cap. Raw IPs, email addresses and user agents are not stored. A free Key Value instance has no disk snapshot, so a KV restart can still clear history.
