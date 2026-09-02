module.exports = {
  apps: [
    {
      name: "mia",
      script: "dist/index.js",
      cwd: __dirname,
      node_args: "--env-file=.env",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
