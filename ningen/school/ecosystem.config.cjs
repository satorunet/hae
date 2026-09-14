// pm2 start ningen/school/ecosystem.config.cjs && pm2 save
// The fly-human's school: visitors' trials and its own practice (one body at a time), at low
// priority so the web services come first.
module.exports = {
  apps: [{
    name: 'hae-ningen-school',
    cwd: __dirname,
    script: 'server.mjs',
    interpreter: '/usr/bin/nice',
    interpreter_args: '-n 15 /usr/bin/node-22',
    env: { SCHOOL_PORT: '3021', SCHOOL_PRACTICE: '2' },
    kill_timeout: 20000,          // it saves its brain on SIGINT
    max_memory_restart: '1500M',
    autorestart: true,
  }, {
    // the search for the body's basic control (tune.mjs): two trial bodies at a time, lowest priority
    name: 'hae-ningen-tune',
    cwd: __dirname,
    script: 'tune.mjs',
    interpreter: '/usr/bin/nice',
    interpreter_args: '-n 19 /usr/bin/node-22',
    env: { TUNE_WORKERS: '4', TUNE_LAMBDA: '8', TUNE_TRIALS: '3' },
    kill_timeout: 600000,         // it finishes its generation on SIGINT
    max_memory_restart: '2500M',
    autorestart: true,
  }],
};
