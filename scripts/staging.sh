#!/usr/bin/env bash
# Runs this checkout beside the live proxy, to look at a change before deploy/up.sh: backend, plugins and
# dashboard on 127.0.0.1:8318, with a copy of deploy/config.yaml, fake accounts and 14 days of fake usage.
# It never copies deploy/data/: a second proxy holding the live OAuth tokens would refresh them and leave
# the live proxy with dead ones.
# Usage: scripts/staging.sh [stop]
set -euo pipefail
cd "$(dirname "$0")/.."
dir=${STAGING_DIR:-/tmp/router-for-me-staging}
port=8318
url=http://127.0.0.1:$port

stop() {
  if [ -f "$dir/server.pid" ]; then
    pid=$(cat "$dir/server.pid")
    if kill "$pid" 2>/dev/null; then
      while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
    fi
    rm -f "$dir/server.pid"
  fi
}

start() {
  # exec, so no shell is left holding this script's output open; run from $dir so no .env is loaded.
  (cd "$dir" && MANAGEMENT_PASSWORD=$(cat password) exec setsid nohup ./cli-proxy-api \
    --config "$dir/config.yaml" --no-browser >server.log 2>&1 </dev/null) &
  echo $! >"$dir/server.pid"
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "$url/management.html" && return
    sleep 0.5
  done
  echo "Staging did not start, see $dir/server.log" >&2
  exit 1
}

if [ "${1:-}" = stop ]; then
  stop
  echo "Staging stopped."
  exit
fi

stop
rm -rf "$dir"
mkdir -p -m 700 "$dir"
plugin_dir=$dir/plugins/$(go env GOOS)/$(go env GOARCH)
mkdir -p "$dir/auths" "$dir/static" "$plugin_dir"

echo "== Building the dashboard, the backend and the plugins"
(cd Cli-Proxy-API-Management-Center && bun install --frozen-lockfile >/dev/null && bun run build >/dev/null)
cp Cli-Proxy-API-Management-Center/dist/index.html "$dir/static/management.html"
(cd CLIProxyAPI && CGO_ENABLED=1 go build -o "$dir/cli-proxy-api" ./cmd/server)
for plugin in plugins/*/; do
  [ -f "$plugin/go.mod" ] || continue
  id=$(basename "$plugin")
  (cd "$plugin" && go build -buildmode=c-shared -o "$plugin_dir/$id.so" .)
  rm -f "$plugin_dir/$id.h"
done

head -c 18 /dev/urandom | base64 | tr -d '/+=' >"$dir/password"
chmod 600 "$dir/password"

# The live config, moved to this port and directory, with usage-stats on; then the fake accounts.
python3 -I - deploy/config.yaml "$dir" "$port" <<'EOF'
import base64, json, os, sys, time
import yaml

source, out, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
config = yaml.safe_load(open(source))
config.setdefault('server', {}).update(host='127.0.0.1', port=port)
config.setdefault('oauth', {})['auth-dir'] = f'{out}/auths'
plugins = config.setdefault('plugins', {})
plugins.update(enabled=True, dir=f'{out}/plugins')
configs = plugins.get('configs') or {}
configs['usage-stats'] = {'enabled': True, 'data_dir': f'{out}/usage-stats'}
plugins['configs'] = configs
path = f'{out}/config.yaml'
with open(os.open(path, os.O_WRONLY | os.O_CREAT, 0o600), 'w') as f:
    yaml.safe_dump(config, f, sort_keys=False)

b64 = lambda data: base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b'=').decode()
now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
far = '2099-01-01T00:00:00Z'  # never due, so the backend never tries to refresh a fake token

def codex(email, plan, **extra):
    account = f'acct-{plan}'
    claims = {'email': email, 'exp': 4070908800,
              'https://api.openai.com/auth': {'chatgpt_plan_type': plan, 'chatgpt_account_id': account}}
    return {'type': 'codex', 'email': email, 'plan_type': plan, 'account_id': account,
            'id_token': f"{b64({'alg': 'none'})}.{b64(claims)}.fake",
            'access_token': f'fake-{account}', 'refresh_token': f'fake-{account}',
            'last_refresh': now, 'expired': far, **extra}

accounts = {
    'codex-fake-pro.json': codex('lead@example.com', 'pro', priority=10),
    'codex-fake-plus.json': codex('dev@example.com', 'plus', priority=5),
    'codex-fake-team.json': codex('team@example.com', 'team'),
    'codex-fake-old.json': codex('old@example.com', 'plus', disabled=True),
    'claude-fake-max.json': {'type': 'claude', 'email': 'dev@example.com', 'access_token': 'fake-claude',
                             'refresh_token': 'fake-claude', 'last_refresh': now, 'expired': far,
                             'priority': 3},
}
for name, body in accounts.items():
    with open(os.open(f'{out}/auths/{name}', os.O_WRONLY | os.O_CREAT, 0o600), 'w') as f:
        json.dump(body, f, indent=2)
EOF

echo "== Starting on $url"
start

# Fake usage needs the auth indexes the backend gave the fake accounts, and the plugin reads its files
# only at startup, so the usage is written now and the backend restarted.
curl -sf -H "Authorization: Bearer $(cat "$dir/password")" "$url/v8/management/routing/models" \
  -o "$dir/credentials.json"
python3 -I - "$dir/credentials.json" "$dir/usage-stats" <<'EOF'
import json, math, os, random, sys, time

source, out = sys.argv[1], sys.argv[2]
os.makedirs(out, mode=0o700, exist_ok=True)
credentials = [c for c in json.load(open(source))['credentials']
               if c.get('source') == 'file' and not c.get('disabled') and c.get('models')]
if not credentials:
    sys.exit('no fake account serves a model, so there is no usage to fake')
rng = random.Random(7)
failures = [(429, '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}'),
            (500, '{"error":{"message":"Internal server error"}}'),
            (502, 'upstream connect error or disconnect/reset before headers')]
keys = ['fake…ptop', 'fake…-ci1']
now = int(time.time())
start = (now // 3600 - 14 * 24) * 3600
days = {}
for hour in range(start, now, 3600):
    local = time.localtime(hour)
    busy = 8 <= local.tm_hour <= 21
    load = 2 + 25 * math.sin(math.pi * (local.tm_hour - 8) / 13) if busy else rng.randint(0, 2)
    if local.tm_wday >= 5:
        load *= 0.35
    for _ in range(int(load * rng.uniform(0.7, 1.3))):
        credential = rng.choice(credentials)
        model = rng.choice(credential['models'][:4])
        t = min(hour + rng.randrange(3600), now - 1)
        entry = {'t': t * 1000, 'model': model['id'], 'upstream': (model.get('upstream') or [model['id']])[0],
                 'provider': credential['provider'], 'auth_index': credential['auth_index'],
                 'auth_id': credential['id'], 'api_key': rng.choice(keys)}
        if rng.random() < 0.04:
            entry['failed'] = True
            entry['status'], entry['message'] = rng.choice(failures)
            entry['latency_ms'] = rng.randint(80, 1500)
        else:
            tokens_in, tokens_out = int(rng.lognormvariate(9.6, 0.8)), int(rng.lognormvariate(6.8, 0.9))
            entry.update({'in': tokens_in, 'out': tokens_out, 'cached': int(tokens_in * rng.uniform(0.3, 0.9)),
                          'total': tokens_in + tokens_out, 'latency_ms': rng.randint(1500, 45000),
                          'ttft_ms': rng.randint(350, 3200)})
        days.setdefault(time.strftime('%Y-%m-%d', time.gmtime(t)), []).append(entry)
for day, entries in days.items():
    entries.sort(key=lambda e: e['t'])
    # .jsonl, never .json: the backend loads every *.json under its auth dir as a credential.
    with open(f'{out}/{day}.jsonl', 'w') as f:
        f.writelines(json.dumps(e, separators=(',', ':')) + '\n' for e in entries)
EOF
rm "$dir/credentials.json"
stop
start

echo
echo "Staging: $url/management.html"
echo "Key:     $(cat "$dir/password")   (your usual management key works too)"
echo "Stop:    $0 stop"
