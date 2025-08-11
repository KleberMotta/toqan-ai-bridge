import Redis from "ioredis";
import dotenv from "dotenv";
dotenv.config();

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/0";
let client: Redis | null = null;

export function getRedis() {
  if (!client) client = new Redis(REDIS_URL);
  return client;
}
