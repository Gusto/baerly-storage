/**
 * pm2 ecosystem file. Run with `pm2 start pm2.config.cjs`.
 * Reads env from `.env` at the same path. Logs to /var/log/baerly/.
 */
module.exports = {
  apps: [
    {
      name: "{{appName}}",
      script: "dist/server.js",
      cwd: __dirname,
      instances: "max", // one per CPU core
      exec_mode: "cluster",
      env_file: ".env",
      max_memory_restart: "1G",
      kill_timeout: 10_000, // matches the server's graceful-shutdown deadline
      out_file: "/var/log/baerly/out.log",
      error_file: "/var/log/baerly/err.log",
      merge_logs: true,
    },
  ],
};
