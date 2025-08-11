import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyFormbody from "@fastify/formbody";
import routes from "./routes";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
dotenv.config();

// Setup debug logging to file
const logFile = path.join(process.cwd(), 'debug.log');

// Ensure log file exists
if (!fs.existsSync(logFile)) {
  fs.writeFileSync(logFile, `=== Toqan Bridge Debug Log - Started ${new Date().toISOString()} ===\n`);
}

export function buildServer() {
  const server = Fastify({ 
    logger: false  // Disable Fastify logging, use custom console logs
  });
  server.register(fastifyMultipart);
  server.register(fastifyFormbody);
  server.register(routes);
  return server;
}
