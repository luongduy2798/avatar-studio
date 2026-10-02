const path = require('node:path')

module.exports = {
  apps: [
    {
      name: 'avatar-master',
      cwd: path.resolve(__dirname, '..'),
      script: 'dist/main.js',
      interpreter: 'node',
      env: { NODE_ENV: 'production', AVATAR_LOCAL_BENCHMARKS: '0' },
    },
  ],
}
