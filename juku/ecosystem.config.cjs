// pm2 start juku/ecosystem.config.cjs && pm2 save
// Two trainers, one core each, at low priority so the web services come first.
const app = (course) => ({
  name: `hae-juku-${course}`,
  cwd: __dirname,
  script: 'trainer.mjs',
  args: course,
  interpreter: '/usr/bin/nice',
  interpreter_args: '-n 10 /usr/bin/node-22',
  kill_timeout: 20000,          // it saves its brain on SIGINT
  max_memory_restart: '800M',
  autorestart: true,
});
// the small API for visitors' handwriting records (no training)
const api = { name: 'hae-juku-api', cwd: __dirname, script: 'api.mjs', interpreter: '/usr/bin/node-22',
  max_memory_restart: '200M', autorestart: true };
module.exports = { apps: [app('suji'), app('hiragana'), api] };
