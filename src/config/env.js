import 'dotenv/config';

const parsedPort = Number(process.env.PORT);

export const env = {
  port: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
};
