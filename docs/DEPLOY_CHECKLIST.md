# Deploy checklist

The API runs as one Supabase Edge Function on the existing project **Drivers Gig Tax**
(`cvxifukwesvcbmygxqts`, ap-southeast-2). The website stays on Netlify. Do not
create a second Supabase project. `fly.toml` is not the host for this API.
Nothing here has been applied or deployed.

The app calls `EXPO_PUBLIC_BACKEND_URL` + `/api/...`, so the base URL is the
function root and the path still starts with `/api`:

`https://cvxifukwesvcbmygxqts.supabase.co/functions/v1/api`

A profile request is
`https://cvxifukwesvcbmygxqts.supabase.co/functions/v1/api/api/profile`.

## 1. Database migration (review first, then apply)

`supabase/migrations/0003_gigtax_api_schema.sql` creates schema `gigtax` with
the JSONB tables the API uses. It does not drop or alter the empty `public`
tables (`profiles`, `vehicles`, `shifts`, `shift_points`, `incomes`,
`expenses`, `receipt_backup_queue`, `sync_log`). Those are a different
Supabase-Auth shape and are not what this app calls.

```bash
supabase link --project-ref cvxifukwesvcbmygxqts
supabase db push
```

## 2. Function secrets

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and
`SUPABASE_DB_URL` are injected by Supabase. Do not copy them into the app.
Set the rest with `supabase secrets set` (values from the place named, never
from git):

| Name | Where the value comes from |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com API keys |
| `ANTHROPIC_MODEL` | optional, default `claude-sonnet-4-6` |
| `ANTHROPIC_VISION_MODEL` | optional, same default (scan is not ported yet) |
| `GOOGLE_CLIENT_ID` | Google Cloud OAuth web client |
| `GOOGLE_CLIENT_SECRET` | same client |
| `APPLE_AUDIENCES` | `com.driversgigtax.app` |
| `OAUTH_REDIRECT_ORIGINS` | `https://driversgigtax.app` |
| `DRIVE_ENCRYPTION_KEY` | existing Fernet key, or a new one if no Drive tokens exist yet |
| `DEMO_ENABLED` | `false` except a review build |
| `DEMO_REVIEW_SECRET` | generate for the review build only |
| `DEMO_ENTITLED` | `false` |
| `DEMO_RATE_LIMIT` | optional, default 5 per minute |
| `AI_RATE_LIMIT` | optional, default 30 per minute |
| `PAYWALL_ENFORCED` | leave unset (`false`) until step 4 |
| `TRIAL_DAYS` | optional, default 14 |
| `REVENUECAT_SECRET_API_KEY` | RevenueCat secret key |
| `REVENUECAT_WEBHOOK_AUTH` | the exact Authorization value you set on the RevenueCat webhook |
| `RC_ENTITLEMENT_ID` | `pro` |
| `CORS_ORIGINS` | optional |

Google authorised redirect URI (Cloud Console):

`https://cvxifukwesvcbmygxqts.supabase.co/functions/v1/api/api/auth/google/callback`

RevenueCat webhook:

`https://cvxifukwesvcbmygxqts.supabase.co/functions/v1/api/api/subscription/webhook`

`supabase/config.toml` sets `verify_jwt = false` for `functions.api` because the
app's `Authorization` bearer is its own session token, not a Supabase JWT.

## 3. Deploy the function (after review)

```bash
supabase functions deploy api --project-ref cvxifukwesvcbmygxqts
curl -fsS https://cvxifukwesvcbmygxqts.supabase.co/functions/v1/api/health
```

Expect `{"status":"ok"}`. If the gateway returns 401 before that JSON, the
platform is still asking for the publishable key on the `apikey` header.
The session token stays in `Authorization`. Confirm that with a curl before
shipping the app; the app itself only changes `EXPO_PUBLIC_BACKEND_URL`.

No `api.driversgigtax.app` DNS record is required for this host.

## 4. Marketing site on Netlify

`netlify.toml` still publishes `website/`. `/api/*` on the site is proxied to
the Edge Function (waitlist). `/privacy`, `/terms`, and `/delete-account`
stay static pages.

Confirm the Netlify site that owns `driversgigtax.app` uses this repo, an
empty build command, and publish directory `website`. Then:

```bash
curl -sI https://driversgigtax.app/
curl -sI https://driversgigtax.app/privacy
curl -sI https://driversgigtax.app/terms
curl -sI https://driversgigtax.app/delete-account
```

Replace the `[TO CONFIRM: …]` placeholders in `website/privacy.html` and
`frontend/app/privacy.tsx` before that deploy.

## 5. Subscriptions

Leave `PAYWALL_ENFORCED` false until RevenueCat entitlement `pro`, the store
products, and real `EXPO_PUBLIC_RC_IOS_KEY` / `EXPO_PUBLIC_RC_ANDROID_KEY`
exist. Then `supabase secrets set PAYWALL_ENFORCED=true`. Do not put a
`test_` key in a release build.

## 6. Android preview APK

`frontend/eas.json` `preview` still builds an APK and now points
`EXPO_PUBLIC_BACKEND_URL` at the function. `app.json` still has no
`extra.eas.projectId` or `owner`. From `frontend/`:

```bash
npx eas-cli@latest init
```

Write the printed values, do not invent them:

- `expo.extra.eas.projectId`: `<id from eas init>`
- `expo.owner`: `<expo username or org slug>`

Then `npx eas-cli build --platform android --profile preview`. Reviewer demo
only: `DEMO_ENABLED=true`, `DEMO_REVIEW_SECRET`, and the same value as
`EXPO_PUBLIC_DEMO_REVIEW_SECRET` on that EAS environment.
