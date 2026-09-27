---
name: gridiron-fly-login-token
description: How to get an app login token for gridiron-hq.fly.dev — the port is API_PORT (not PORT), the old fixed 5177 fly ssh one-liner failed with ECONNREFUSED on 2026-09-19.
metadata:
  type: project
  modified: 2026-09-19T15:56:00.773Z
---

The live app at gridiron-hq.fly.dev serves its React shell to anyone, but
`/api/leagues`, `/api/players`, `/api/teams`, `/api/stats` and
`/api/league-chat/*` all return 401 without a session token. Reaching the host
is not the same as being able to read it.

## The port gotcha (found 2026-09-19)

**The app reads `API_PORT`, not `PORT`** — `server/index.js:6` is
`Number(process.env.API_PORT) || 5177`. Checking `PORT` inside the machine
tells you nothing. `server/index.js:148` is `process.env.HOST || '127.0.0.1'`,
and `fly.toml` in the repo sets `HOST = "0.0.0.0"` with
`internal_port = 5177`.

The previously recorded one-liner hardcoded `127.0.0.1:5177` and **failed with
ECONNREFUSED** for Nick on 2026-09-19. Two candidate causes, not yet
distinguished: the deployed machine sets `API_PORT` to something other than
5177, or its `HOST` binds only the Fly 6PN address so the IPv4 loopback is
refused. The repo `fly.toml` also says `auto_stop_machines = false` while the
machine observably auto-stops, so the deployed config differs from the branch.

Use a command that discovers instead of assuming. This shape is verified to
survive the shell quoting (single quotes only inside the JS, no backticks, no
`$`), and it either prints the token or prints the machine's real `API_PORT`,
`HOST` and listening ports:

```
fly ssh console -a gridiron-hq -C "node -e \"const f=require('fs'),P=[...new Set([process.env.API_PORT,5177,8080,3000].filter(Boolean).map(Number))],L=p=>{try{return f.readFileSync(p,'utf8').split('\n').slice(1).filter(l=>l.trim()).map(l=>l.trim().split(/ +/)).filter(x=>x[3]==='0A').map(x=>parseInt(x[1].split(':')[1],16))}catch(e){return[]}};(async()=>{for(const h of ['127.0.0.1','[::1]'])for(const p of P){try{const o=await(await fetch('http://'+h+':'+p+'/api/auth/local-session',{method:'POST'})).json();if(o.token){console.log(o.token);process.exit(0)}}catch(e){}}console.log('NO TOKEN. API_PORT='+(process.env.API_PORT||'unset')+' HOST='+(process.env.HOST||'unset')+' listening='+[...new Set([...L('/proc/net/tcp'),...L('/proc/net/tcp6')])].sort((a,b)=>a-b).join(','))})()\""
```

`/api/auth/local-session` (`server/routes/local-auth.js:64`) answers only a
direct loopback caller: `isLoopback` accepts `127.0.0.1`, `::1` and
`::ffff:127.0.0.1`, and `isDirectLoopback` rejects anything carrying
`x-forwarded-for`, `fly-client-ip`, `cf-ray` and similar. It issues a 90-day
token and persists only a digest.

**Simpler path when it already exists:** the token in the project's
environment-variables box as `GRIDIRON_FLY_TOKEN` is a plain 90-day app
token and works from anywhere — verified against
`/api/league-chat/status` (200) on 2026-09-19. Nothing about it is
machine-specific, so if Nick can still read that value he can paste it into
his Mac's `.env` and skip `fly ssh` entirely.

The phone-pairing flow in the same file is not an escape hatch: minting a
pairing code itself requires direct loopback plus an existing session.

**Delivery: the environment variables box, never in chat.** Only sessions
started after the variable is saved will see it.

See [[fly-network-access-resolved]], [[fly-deployment-outside-repo]] and
[[league-chat-sync-command]].
