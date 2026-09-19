# Turning on Google sign-in

Five steps. The code is already deployed-ready; these are the parts only the
account owner can do, because they involve a Google Console account and Fly
secrets.

Everything here is reversible: until `GOOGLE_OAUTH_CLIENT_ID` and
`GOOGLE_OAUTH_CLIENT_SECRET` are both set, the app reports
`{"google": false}` at `GET /api/auth/providers`, draws no Google button, and
behaves exactly as it does today.

---

## 1. Create the OAuth client

Go to <https://console.cloud.google.com/apis/credentials>, pick or create a
project, then **Create credentials → OAuth client ID → Web application**.

If it asks you to configure the consent screen first: **External**, user type
**Testing** is fine, app name `Gridiron HQ`, your own email for both support
and developer contact. No scopes need adding by hand — the app asks for
`openid email profile` at sign-in time and nothing else, none of which are
restricted or need verification.

On the client itself, fill in exactly these two, with no trailing slash:

| Field | Value |
|---|---|
| Authorised JavaScript origin | `https://gridiron-hq.fly.dev` |
| Authorised redirect URI | `https://gridiron-hq.fly.dev/api/auth/google/callback` |

Google compares the redirect URI byte for byte. If it is wrong, sign-in fails
at Google with `redirect_uri_mismatch` before it ever reaches the app. The
running app prints the URI it expects at `GET /api/auth/providers`, so that is
the value to trust if these ever disagree.

Copy the client ID and client secret off the confirmation dialog.

## 2. Set the secrets on Fly

Fly secrets are a separate store from the environment-variables box; setting a
variable in the box does not reach the deployment.

```
fly secrets set \
  GOOGLE_OAUTH_CLIENT_ID='<the client id>' \
  GOOGLE_OAUTH_CLIENT_SECRET='<the client secret>' \
  GRIDIRON_ADMIN_EMAIL='<your google address>' \
  GRIDIRON_PUBLIC_URL='https://gridiron-hq.fly.dev' \
  -a gridiron-hq
```

`fly secrets set` restarts the machine, which is when migration 061 runs and
creates the three new tables.

- `GRIDIRON_ADMIN_EMAIL` is the one address that may claim an account without
  an invite. On its first sign-in it attaches to the account that already owns
  the five ESPN leagues rather than creating a second one, so nothing moves.
  It must be the Google address you will actually sign in with.
- `GRIDIRON_PUBLIC_URL` pins the origin used to build the redirect URI. Without
  it the app derives the origin from the proxy's forwarded headers, which is
  correct here but is one more thing that has to stay true.

## 3. Check it before you trust it

```
curl -s https://gridiron-hq.fly.dev/api/auth/providers
```

Expect `"google": true` and a `redirect_uri` byte-identical to the one
registered in step 1.

## 4. Sign in

Open <https://gridiron-hq.fly.dev/sign-in> and press Continue with Google.
You should land on the League page with all five leagues, because the account
you signed into is the account that already had them.

## 5. Invite anyone else

Invites are written by an administrator — the account holding the `model:*`
grant, which is yours.

```
curl -s -X POST https://gridiron-hq.fly.dev/api/auth/invites \
  -H "Authorization: Bearer $GRIDIRON_FLY_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"email":"friend@example.com","note":"league mate"}'
```

They then sign in at `/sign-in` with that Google address. An address with no
open invite is refused, and the refusal writes nothing at all — no account, no
disabled shell.

Other endpoints on the same family: `GET /api/auth/invites` lists them,
`DELETE /api/auth/invites/:id` revokes one that has not been accepted,
`GET /api/auth/accounts` lists who has an account, and
`POST /api/auth/accounts/:id/disabled` with `{"disabled":true}` turns one off
and revokes the sessions it already holds.

---

## If it goes wrong

| What you see | Cause | Fix |
|---|---|---|
| `redirect_uri_mismatch` at Google | The URI in step 1 does not match what the app sends | Compare against `GET /api/auth/providers` and correct the Console entry |
| Sign-in page says Google is not configured | One of the two secrets is missing or empty | `fly secrets list -a gridiron-hq` and re-set the missing one |
| `This Google account has not been invited` | Signing in with an address that is neither `GRIDIRON_ADMIN_EMAIL` nor invited | Check the address on the account you picked at Google; it is case-insensitive but must otherwise match |
| Signed in but no leagues | The admin address adopted a *different* account, or a second account already held the Google identity | `GET /api/auth/accounts` shows which account holds what; the adoption only happens on the very first Google sign-in for that address |
| `access_denied` | You pressed cancel at Google | Try again |

## What this does not do

It does not give each user their own ESPN connection or their own Anthropic
key. Both are still install-wide, which is fine while the invite list is people
who share Nick's leagues and is not fine before this is opened wider. See the
thread this shipped from for the specifics.
