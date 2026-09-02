# Where we are, in plain English

*Written 2026-09-02, one week before the NFL season. No jargon on purpose.*

## What the model actually does

Gridiron HQ watches every NFL game the way a careful analyst would. Before a
game it gathers everything that is knowable at that moment: how good each
team has been, who is hurt, who is starting at quarterback, the weather at
kickoff, and what every sportsbook is offering. From that it forms its own
opinion of the game, writes that opinion down with a timestamp so it can
never be changed after the fact, and then, once the game is over, grades
itself honestly.

It has a lot of these opinions. Seventeen separate "specialists" each look at
the game from a different angle (matchups, injuries, the quarterback, how
the line has moved, and so on), and a coordinator decides how much to trust
each one based on how right they have been in the past. Everything is paper
money. Nothing is actually wagered.

## What it is good at

- **It does not lie to itself.** This is the part that is genuinely rare.
  Every prediction is frozen before kickoff, every grade is done by a rule
  that was written down in advance, and the system throws out a result if the
  code changed halfway through a test. Most hobby betting models never do
  this and end up fooling their owner.
- **It knows when it has nothing to say.** When the specialists cannot beat
  the sportsbooks, the coordinator says so and recommends nothing. That is
  the correct behaviour and it took real work to get there.
- **Player-level forecasts.** The engine that predicts what individual
  players will do (yards, catches, touchdowns) is measurably better than
  simple rules of thumb, and its touchdown forecasts in particular are
  strong.
- **Watching the market.** Right now it reads eleven sportsbooks every hour
  for free, tracks Polymarket every fifteen minutes for line movement, and
  keeps four seasons of opening and closing lines from all of those books.

## What it is not good at, honestly

Picking the winner against the spread. Over four seasons of replayed games
none of the seventeen specialists beats the sportsbooks' own number. The
test that finished today (run 17, the cleanest replay yet: 831 games,
2022 through 2025) ended 55 wins, 58 losses, down 7.5 units, a return of
minus 6.5 percent. It was up two units at the halfway mark and gave it all
back, which is exactly what luck looks like. Every one of the seventeen
specialists earned a weight of zero by the end, including the two that
looked promising midway. The coordinator that combines them called the
right side 49.9 percent of the time. This matches the previous full run
almost exactly, so it is not a fluke of one test. We should not expect the
"pick the side" part of the model to make money, and the roadmap does not
depend on it. That result is the most useful thing run 17 produced: it
closes the question and lets us stop spending effort there.

One more thing today's work turned up: one of the free sportsbook feeds
was quietly serving prices that were weeks out of date, and a few of the
model's Week 1 paper bets were recorded at those phantom prices. That is
fixed now, and those bets are marked so they cannot flatter the results.

The other piece of today's work is a real start on player props, the
market this brief called the single biggest unlock, and it went further
than expected. A new connector now pulls real prop prices for free from
two sites (Underdog and Action Network), and those prices are now hooked
directly into the model's own predictions. That connection had never
existed before today. The first real pull brought in 840 genuine,
two-sided prices covering all sixteen Week 1 games, and after finding and
fixing a data bug (the site was giving us player names in a format our
code wasn't reading correctly), the model correctly identified the right
player for 98 percent of those bets. From that, it has already produced
64 real cases where its own number disagrees with the market's price. None
of those has been graded yet, since Week 1 hasn't happened, but for the
first time this project has a live, honest scoreboard for its best skill
instead of an empty one. The next step is simply letting the record build
up until there are enough graded bets to trust it.

## The one real finding

The sportsbooks' **opening** line is beatable in a narrow way. When our team
ratings disagree with Pinnacle's opening number, the line tends to move our
way by kickoff, by about half a point on average, and by a full point in
close games. Wind at kickoff also pushes totals down and the opener does
not price it in. Neither of those is a jackpot, but both are real, both
were measured on games the model had never seen, and both can be checked
every week by one simple question: did the line move in our direction
after we spoke? That question is called closing line value, and it is the
only scoreboard this project uses until there is enough history to trust
win-loss records.

## Where the money most likely is

Three places, in order of how sure we are:

1. **Betting early on the close games where our ratings disagree with the
   opener**, at the best price any of the eleven books is offering. This is
   live now at zero units for Week 1.
2. **Player props.** This is the market where the model has the most
   skill and the market is the sloppiest, but we have never once compared
   our numbers to a real prop price because the paid feed ran out. Getting
   prop prices for free is the single biggest unlock in the roadmap.
3. **Price and speed, not prediction.** Books disagree with each other by
   almost a point on average. Taking the best available number, and betting
   the slow books when the sharp book has already moved, is an edge that
   needs no forecast at all. We have the data to measure it this season.

## How the roadmap gets from here to profit

The plan runs in phases that follow the calendar of the season.

- **Before Week 1 kicks off:** fix the small things that would poison the
  evidence, such as a stale sportsbook feed that was making some prices look
  better than they really are, and turn on the wind rule for totals.
- **Weeks 1 to 2:** start capturing player prop prices from free sources so
  the model's strongest skill finally gets tested against real numbers.
- **Weeks 1 to 6:** let the early-line rule, the wind rule, and the
  "bet the slow book" rule run on paper and grade every single decision by
  whether the line moved our way. Retire anything that does not.
- **Weeks 6 to 12:** by then there should be a couple of hundred graded
  decisions. If the scoreboard is positive with room to spare, the plan
  calls for a very small real-money pilot, sized so that a bad month cannot
  hurt. If it is not, the plan says so and nothing gets staked.
- **In the background all season:** keep the honest replay running, keep
  the specialists reporting, and borrow good ideas from public models where
  they add something ours does not already know.

## What "profit" realistically means

Even a genuinely good sports bettor wins about 54 to 55 percent of the time
against the spread. That is a few percent return on the money wagered, not
a lottery ticket. The value of this project is that it will know, with
evidence, whether it has that few percent, and it will refuse to pretend
otherwise. That refusal is the thing most people building these systems
never manage.
