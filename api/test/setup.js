Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@127.0.0.1:1/test",
  TOKEN_ENC_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  URL_SIGNING_SECRET: "signing-secret-signing-secret-signing",
  REDIS_URL: "redis://127.0.0.1:1",
  UPLOAD_DIR: "/tmp/omni-test-uploads",
  GOOGLE_CLIENT_ID: "gid",
  GOOGLE_CLIENT_SECRET: "gsecret",
});
