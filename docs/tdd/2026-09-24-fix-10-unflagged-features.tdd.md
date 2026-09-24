# FIX-10: flags for the two unflagged user-visible features

Two features reached the UI with no switch: #237's Number health card and nav dot, and
#239's TradeCard "I sent this" button. Each now has a default-off flag with a one-file
reader that ORs in preview mode (`previewUnconfirmed()`) and puts the preview label on
the response. #235's brain report already had its flag; it is added to the list of
converted sites in `server/services/preview-mode.js`.

This branch contains #237 (`claude/cloud-broken-01`) and #239
(`claude/cloud-clone-01b-b1-5nyb26`) merged onto origin/main `12a6de93`, because neither
had merged when this unit started.

## Switches

| Flag | Reader | What it gates | Not gated |
|---|---|---|---|
| `GRIDIRON_NUMBER_HEALTH` | `server/services/number-health-flag.js#numberHealthFields` | `GET /api/number-audit`; the Settings card and nav dot render nothing unless it says `enabled: true` | the refresh-loop audit job (it only writes `number_audit`) |
| `GRIDIRON_OFFER_LOOP` | `server/services/offer-loop-flag.js#offerLoopFields` | `POST /api/trades/:leagueId/offers/sent` (records nothing when off); new `GET` on the same path that the button reads | the post-sync settler (`settleOfferLoop`) |

Each reader returns `{enabled:false, reason}` when off, `{enabled:true}` when its flag is
`'1'`, and `{enabled:true, preview:true, preview_reason}` when it is on only through
preview mode. The site flag wins over preview, as in the existing converted sites.

The button moved out of `TradeCard.tsx` into `client/src/components/trade/SentOfferButton.tsx`
so it can be rendered in a test without TradeCard's other imports. Its POST and copy are
unchanged.

## RED / GREEN

- RED `8815ed2a`: `test/fix-10-flags.test.js` fails with `ERR_MODULE_NOT_FOUND`
  (`number-health-flag.js`); `test/number-audit.test.js` 3 fail (13 pass);
  `test/trade-outcomes-route.test.js` 1 fail (7 pass).
- GREEN (next commit): fix-10-flags 6/6, number-audit 16/16, trade-outcomes-route 8/8,
  offer-loop 12/12, preview-mode 3/3, ux08b-alert-error-no-leak 28/28 (it stubs every
  TradeCard import, so the new one was added to its list).

## Mutants (each applied alone, each killed)

| Mutant | Killed by |
|---|---|
| M1: drop the flag guard on `POST /offers/sent` | trade-outcomes-route, FIX-10 case (1 fail) |
| M2: drop the `enabled !== true` guard on the Number health card | number-audit, FIX-10 card case (1 fail) |
| M3: drop the `enabled !== true` guard on SentOfferButton | fix-10-flags, "absent" case (1 fail) |

## Not confirmed

- The flag state reaches the page through a fetch, so for the first paint the card and
  button are absent until the route answers. That is the intended failure direction.
- Neither flag is set anywhere (`fly.toml`, `run.sh`), so both features are off on every
  deploy until someone sets them.
