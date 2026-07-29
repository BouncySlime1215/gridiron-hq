import express from 'express';
import { db } from './db/index.js';
import { seedIfEmpty } from './db/seed/index.js';
import teamsRouter from './routes/teams.js';
import playersRouter from './routes/players.js';
import rankingsRouter from './routes/rankings.js';
import draftsRouter from './routes/drafts.js';
import espnRouter from './routes/espn.js';
import newsRouter from './routes/news.js';
import aggregatesRouter from './routes/aggregates.js';
import analysisRouter from './routes/analysis.js';
import leaguesRouter from './routes/leagues.js';
import nfldataRouter from './routes/nfldata.js';
import statsRouter from './routes/stats.js';
import devRouter from './routes/dev.js';

const app = express();
app.use(express.json());

seedIfEmpty();

app.use('/api/teams', teamsRouter);
app.use('/api/players', playersRouter);
app.use('/api/rankings', rankingsRouter);
app.use('/api/drafts', draftsRouter);
app.use('/api/espn', espnRouter);
app.use('/api/news', newsRouter);
app.use('/api/aggregates', aggregatesRouter);
app.use('/api/analysis', analysisRouter);
app.use('/api/leagues', leaguesRouter);
app.use('/api/nfl', nfldataRouter);
app.use('/api/stats', statsRouter);
app.use('/api/dev', devRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.API_PORT || 5177;
app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
