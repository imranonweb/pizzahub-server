import { env } from './config/env.js';
import app from './app.js';

app.listen(env.port, () => {
  console.log(`PizzaHub server is running on port ${env.port} (${env.nodeEnv})`);
});
