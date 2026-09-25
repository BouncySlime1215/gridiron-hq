# Coach drawer presets never 500 (#390, Batch B item 6)

Test: `test/coach-drawer-presets.test.js`.

## RED (test commit, code at the merge of origin/main)

`node --test test/coach-drawer-presets.test.js`: 2 pass, 5 fail.

- Four of the six drawer questions ("Is it safe to send?", "Who should I work this week?",
  "What did league-mates say lately?", "What's broken right now?") had no $0 intent: with no
  key they got the "Coach has no model key" refusal, not an answer.
- `people_read` on the model path threw `TypeError: profileReader.readProfiles is not a function`
  (brain-tools.js called an export the ONE-READER merge removed), which the route returned as 500.

## GREEN

`node --test test/coach-drawer-presets.test.js`: 7 pass, 0 fail.
`# METRIC {"leagues":6,"questions":6,"asked":36,"status_200":36,"model_calls":0}`

- `starter-answers.js`: intents `safe_to_send`, `said_lately`, `broken`; "who should I work" joins `message_first`.
- `preset-claims.js` (new): the claims for those three, grounded like every starter answer.
- `brain-tools.js`: `profilesFromReader` maps `profile-reader.js#peopleProfileFromChat` to people_read's input.
- `brief-claims.js`: "who to message first" says the partner basis in plain words and the edge only in title odds.
