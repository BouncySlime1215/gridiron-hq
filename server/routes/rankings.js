import { Router } from 'express';
import { db, rows, row, run } from '../db/index.js';

const r = Router();

r.get('/', (req, res) => {
  res.json(rows(`SELECT rs.*, COUNT(re.id) AS entry_count
                 FROM ranking_sets rs LEFT JOIN ranking_entries re ON re.set_id = rs.id
                 GROUP BY rs.id ORDER BY rs.created_at DESC`));
});

r.post('/', (req, res) => {
  const { name, scoring = 'PPR', copyFrom } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  run('INSERT INTO ranking_sets (name, scoring) VALUES (?,?)', name, scoring);
  const id = row('SELECT last_insert_rowid() AS id').id;
  if (copyFrom) {
    run(`INSERT INTO ranking_entries (set_id, player_id, rank, tier, note)
         SELECT ?, player_id, rank, tier, note FROM ranking_entries WHERE set_id = ?`, id, copyFrom);
  }
  res.json(row('SELECT * FROM ranking_sets WHERE id = ?', id));
});

r.delete('/:id', (req, res) => {
  run('DELETE FROM ranking_sets WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

r.get('/:id/entries', (req, res) => {
  res.json(rows(`SELECT re.*, p.name, p.position, p.espn_id, p.sleeper_id, t.abbr AS team_abbr, t.primary_color
                 FROM ranking_entries re
                 JOIN players p ON p.id = re.player_id
                 LEFT JOIN nfl_teams t ON t.id = p.team_id
                 WHERE re.set_id = ? ORDER BY re.rank`, req.params.id));
});

// Full reorder: body is [{player_id, rank, tier, note}]
r.put('/:id/entries', (req, res) => {
  const setId = req.params.id;
  const entries = req.body;
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'array required' });
  db.exec('BEGIN');
  try {
    run('DELETE FROM ranking_entries WHERE set_id = ?', setId);
    const ins = db.prepare('INSERT INTO ranking_entries (set_id, player_id, rank, tier, note) VALUES (?,?,?,?,?)');
    for (const e of entries) ins.run(setId, e.player_id, e.rank, e.tier ?? 1, e.note ?? null);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true, count: entries.length });
});

// Add a single player to the bottom of a set
r.post('/:id/entries', (req, res) => {
  const setId = req.params.id;
  const { player_id } = req.body;
  const max = row('SELECT COALESCE(MAX(rank),0) AS m FROM ranking_entries WHERE set_id = ?', setId).m;
  run('INSERT OR IGNORE INTO ranking_entries (set_id, player_id, rank, tier) VALUES (?,?,?,?)',
    setId, player_id, max + 1, 6);
  res.json({ ok: true });
});

export default r;
