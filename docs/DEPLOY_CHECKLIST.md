# Deploy checklist

Do these before a preview APK or a store submission. Nothing in this file has been run against production.

## 1. Backend on Fly.io (Sydney)

The app name in `fly.toml` is `driversgigtax-api`. The image installs `backend/requirements.txt` (runtime only) via `backend/Dockerfile`.

From the repo root, with the Fly CLI logged in:

```bash
fly apps create driversgigtax-api --org <your-fly-org>
fly secrets set \
  SUPABASE_DB_URL= \
  ANTHROPIC_API_KEY= \
  GOOGLE_CLIENT_ID= \
  GOOGLE_CLIENT_SECRET= \
  DRIVE_ENCRYPTION_KEY= \
  OAUTH_REDIRECT_ORIGINS=https://driversgigtax.app \
  APPLE_AUDIENCES=com.driversgigtax.app
fly deploy
```

Set the secret values in the Fly dashboard or your shell, not in git. Names match `backend/.env.example`. Leave `PAYWALL_ENFORCED` unset (default false) until step 4.

Confirm:

```bash
curl -fsS https://driversgigtax-api.fly.dev/health
```

Expect `{"status":"ok"}`.

## 2. DNS for api.driversgigtax.app

`api.driversgigtax.app` has no DNS record until this is done. The app and `eas.json` call `https://api.driversgigtax.app`.

```bash
fly certs add api.driversgigtax.app
fly certs show api.driversgigtax.app
```

At the DNS host for `driversgigtax.app`, add the records `fly certs show` prints (typically a CNAME or A/AAAA for `api`). Wait until:

```bash
curl -fsS https://api.driversgigtax.app/health
```

returns `{"status":"ok"}`.

## 3. Marketing site on Netlify

`netlify.toml` publishes the `website/` directory and maps `/privacy`, `/terms`, and `/delete-account` to the HTML files. `https://driversgigtax.app/` and `/privacy` currently return Netlify's own 404, including for `/`, so the domain is not serving this publish directory.

In the Netlify site that owns `driversgigtax.app`:

- Repository: this repo. Base directory: repo root. Build command: empty. Publish directory: `website` (already set by `netlify.toml`).
- Attach `driversgigtax.app` and `www.driversgigtax.app`.
- Deploy, then confirm each of these is HTTP 200 and is the page from `website/`, not Netlify's "Page not found":

```bash
curl -sI https://driversgigtax.app/
curl -sI https://driversgigtax.app/privacy
curl -sI https://driversgigtax.app/terms
curl -sI https://driversgigtax.app/delete-account
```

Before that deploy, replace the `[TO CONFIRM: …]` placeholders in `website/privacy.html` and `frontend/app/privacy.tsx` (legal entity, ABN, postal address, backup retention).

## 4. Subscriptions, then turn the paywall on

`PAYWALL_ENFORCED` stays false until all of the following exist:

1. RevenueCat entitlement `pro`, offering with monthly and yearly packages, no store intro offer (the server already grants 14 days).
2. App Store and Play products at A$19.99 / month and A$199.99 / year.
3. An EAS build whose environment has `EXPO_PUBLIC_RC_IOS_KEY` (`appl_…`) and `EXPO_PUBLIC_RC_ANDROID_KEY` (`goog_…`). Do not set `EXPO_PUBLIC_RC_TEST_KEY` on a release build. A `test_` value in a release build is ignored, and RevenueCat stays off when those store keys are absent.
4. Backend secrets `REVENUECAT_SECRET_API_KEY` and `REVENUECAT_WEBHOOK_AUTH`. Webhook URL: `https://api.driversgigtax.app/api/subscription/webhook`.

Then:

```bash
fly secrets set PAYWALL_ENFORCED=true
```

## 5. Android preview APK (EAS)

`frontend/eas.json` profile `preview` already sets `android.buildType` to `apk` (the `production` profile is an AAB). `frontend/app.json` does not yet have an Expo project id or owner. Do not invent them.

From `frontend/`, logged into the Expo account that should own the app (`npx eas-cli login`, or `EXPO_TOKEN`):

```bash
npx eas-cli@latest init
```

That writes:

- `expo.extra.eas.projectId`: `<paste the id eas init prints>`
- `expo.owner`: `<expo username or org slug>`

Commit those two fields. Then:

```bash
npx eas-cli build --platform android --profile preview
```

Accept EAS-managed Android credentials on the first build so Expo generates the keystore. Download the `.apk` from the build page. Do not run this until step 2 is done, or the installed app will call a host that does not resolve.

Reviewer demo, only on a review build: set backend `DEMO_ENABLED=true` and `DEMO_REVIEW_SECRET`, and the same secret as `EXPO_PUBLIC_DEMO_REVIEW_SECRET` in that EAS environment. Leave both empty for a public build.
