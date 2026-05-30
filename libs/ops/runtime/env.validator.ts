export function validateEnv() {
  const required = ['NODE_ENV', 'PORT'];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required env: ${key}`);
    }
  }

  return true;
}