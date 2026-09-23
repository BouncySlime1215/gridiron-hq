import subprocess, os, tempfile, sys
WT=os.getcwd()  # run from the worktree root
P='server/news/player-news.js'; R='server/routes/players.js'; N='server/routes/news.js'
muts=[
 ('M1 card call site drops newest', R, "news: playerNews(player.id),", "news: playerNews(player.id).slice(1),"),
 ('M2 desk call site back to raw entities', N, "attributeStory(story, attribution);", "(safeJson(story.entities_json, {}).players ?? []);"),
 ('M3 preceder check always passes', P, "  const before = headline.slice(0, at).trimEnd();\n  if (!before) return true;", "  const before = headline.slice(0, at).trimEnd();\n  return true;"),
 ('M4 follower check always passes', P, "  const after = headline.slice(end);", "  return true;\n  const after = headline.slice(end);"),
 ('M5 order by id not published_at', P, "ORDER BY COALESCE(n.published_at, n.date) DESC, n.id DESC", "ORDER BY n.id DESC"),
 ('M6 headline team ignored', P, "  for (const team of index.teamPatterns) if (team.pattern.test(headline)) ids.add(team.id);", ""),
 ('M7 resolved ids ignored', P, "  for (const player of parseEntities(story.entities_json).players ?? []) {", "  for (const player of []) {"),
 ('M8 analyze call site empty', R, "const news = playerNews(player.id);", "const news = [];"),
 ('M9 DESIGNED SURVIVOR team-word surname skip removed', P, " || teamWords.has(family)) continue;", ") continue;"),
 ('M10 NOT-APPLIED CONTROL', P, "THIS_STRING_DOES_NOT_EXIST", "x"),
]
for name, f, old, new in muts:
    path=os.path.join(WT,f); s=open(path).read(); applied = old in s
    if applied: open(path,'w').write(s.replace(old,new,1))
    d=tempfile.mkdtemp()
    env=dict(os.environ, SCHEDULER_DISABLED='1', GRIDIRON_DB_PATH=d+'/x.sqlite')
    out=subprocess.run(['node','--experimental-test-module-mocks','--test','--test-reporter=tap','test/player-news-one-producer.test.js'],cwd=WT,env=env,capture_output=True,text=True).stdout
    fails=[l for l in out.splitlines() if l.startswith('not ok')]
    subprocess.run(['git','checkout','--',f],cwd=WT); subprocess.run(['rm','-rf',d])
    print(f"{name}: applied={applied} -> {'KILLED '+'; '.join(x[7:60] for x in fails) if fails else 'SURVIVED'}")
print(subprocess.run(['git','status','--short'],cwd=WT,capture_output=True,text=True).stdout or 'clean')
