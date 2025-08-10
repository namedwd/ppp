module.exports = {
  apps: [{
    name: 'packing-api',
    script: 'index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    }
  }, {
    name: 'video-processor',
    script: 'video-processor.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production'
    },
    cron_restart: '0 3 * * *',  // 매일 새벽 3시 재시작
    error_file: './logs/video-processor-error.log',
    out_file: './logs/video-processor-out.log',
    log_file: './logs/video-processor-combined.log',
    time: true
  }]
};
