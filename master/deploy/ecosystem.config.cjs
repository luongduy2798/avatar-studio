const path = require('node:path')

module.exports = {
  apps: [
    {
      name: 'avatar-master',
      cwd: path.resolve(__dirname, '..'),
      script: 'deploy/start.sh',
      interpreter: 'bash',
      env: { NODE_ENV: 'production', AVATAR_LOCAL_BENCHMARKS: '0' },
    },
  ],
}
