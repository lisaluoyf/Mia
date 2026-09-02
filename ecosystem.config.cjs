const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "mia",
      script: "dist/index.js",
      cwd: __dirname,
      node_args: `--env-file=${path.join(__dirname, ".env")}`,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
