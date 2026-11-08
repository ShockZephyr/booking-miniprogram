const path = require("path");

module.exports = {
  apps: [
    {
      name: "wechat-booking-api",
      cwd: path.join(__dirname, "backend"),
      script: "npm",
      args: "start",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      kill_timeout: 20000,
      restart_delay: 3000,
      env: {
        NODE_ENV: "production",
        BOOKING_ENV_FILE: process.env.BOOKING_ENV_FILE || "/etc/booking/production.env"
      },
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z"
    }
  ]
};

