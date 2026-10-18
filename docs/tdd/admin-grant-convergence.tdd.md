# admin-grant-convergence — TDD report

**Item:** `GRIDIRON_ADMIN_EMAIL` grants administrator rights on every sign-in,
not only on the sign-in that created or linked the Google identity.

**Files owned and changed:** `server/platform/account-link.js`,
`test/admin-grant-convergence.test.js`, this document.

**Origin:** raised as a caveat by the UI thread during the Google sign-in work,
then verified in the code rather than taken on trust.

---

## 1. Audit — what was there

`resolveGoogleAccount` has two branches. The second one, which creates or links
an identity, ends with `if (isOwner) grantAdmin(userId);` at line 144. The
first one — the branch every sign-in after the first takes, because the
identity now exists — refreshes the profile and returns at line 93 without
ever evaluating the address.

So the grant was **one-shot, not convergent**. An account that already carried
a Google identity at the moment `GRIDIRON_ADMIN_EMAIL` was pointed at its
address could never acquire the grant, no matter how many times it signed in.
Nothing logged it and nothing surfaced it: the account simply came back with
`admin: false` forever, and the setting that was supposed to fix that had
already been read and discarded.

The window is narrow, which is why this is its own small change and not an
emergency. An uninvited non-owner is refused at line 98 *before any row is
written*, and a refused attempt leaves nothing behind — so an install whose
`GRIDIRON_ADMIN_EMAIL` was simply mistyped self-heals the moment it is
corrected. The stuck case needs a specific order of events: an invited sign-in
creates the identity first, and the address is pointed at it afterwards.

That is exactly the order this deployment is in. Sign-up here was invite-only
before `GRIDIRON_ADMIN_EMAIL` was ever set on the Fly machine.

## 2. RED

`test/admin-grant-convergence.test.js`, 5 cases, against the unmodified
`account-link.js`:

```
not ok 1 - THE BUG: an account that already has a Google identity acquires the grant when the setting is later pointed at it
not ok 2 - the grant is asserted once, not accumulated on every sign-in
not ok 5 - changing the setting does NOT revoke anyone: that is a different policy against a table this module does not own
# pass 2
# fail 3
```

Cases 3 and 4 pass in both states **by design**. They are not measuring the
fix, they are the guard against the failure the fix could plausibly introduce:
now that the address is read on every sign-in, a blank setting read as "matches
everyone" would hand `model:*` to each returning account in turn. Case 4 pins
that shut — `adminEmail()` folds an empty string to null, an empty setting
grants nobody, and an uninvited address is still refused outright and still
leaves no row behind.

## 3. GREEN

One condition, on the branch that was returning early:

```js
if (adminEmail() != null && email === adminEmail()) grantAdmin(user.id);
```

Placed before the `COMMIT`, so the grant lands in the same transaction as the
profile refresh and the `isAdmin(user.id)` in the returned summary already sees
it. `email` there is the freshly Google-verified address, the same value the
create/link branch compares — so the two branches now apply one policy rather
than two.

```
# tests 5
# pass 5
# fail 0
```

## 4. The asymmetry, stated on purpose

The grant converges. A **revocation** does not, and that is a decision rather
than an omission.

`model_permissions` is not this module's table. It also holds `model:train`,
`model:promote` and `model:execute`, handed out per user by
`platform/provision-auth.js` for reasons that have nothing to do with
`GRIDIRON_ADMIN_EMAIL`. "Withdraw what the address no longer justifies" is a
second policy over a shared table, and it fails much worse than the bug it
would fix: a mistyped address would strip the real administrator on their next
sign-in, and the fix for *that* requires an administrator.

Case 5 asserts the non-behaviour directly, so nobody later reads the asymmetry
as an oversight: after the address moves to a second account, the second
account gains the grant, the first keeps it, and a narrower `model:train` grant
on either is untouched.

## 5. Full suite

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`,
`npm run start:smoke` — recorded in the pull request.
