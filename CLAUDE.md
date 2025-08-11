# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
- `yarn dev` - Start development server with hot reload using ts-node-dev
- `yarn build` - Compile TypeScript to JavaScript in dist/
- `yarn start` - Run production server from dist/index.js
- `yarn test` - Run Jest tests with --runInBand flag

### Docker
- `docker-compose up` - Start Redis and the bridge service
- `docker-compose up redis` - Start only Redis for local development

## Environment Variables

Required environment variables (use .env file or docker-compose):
- `TOQAN_API_KEY` - API key for Toqan service authentication
- `TOQAN_BASE_URL` - Toqan API endpoint (defaults to https://api.coco.prod.toqan.ai/api)
- `REDIS_URL` - Redis connection string (defaults to redis://localhost:6379/0)
- `POLL_INTERVAL` - Polling interval in seconds for answer retrieval (default: 0.5)
- `POLL_TIMEOUT` - Maximum polling timeout in seconds (default: 30)
- `PORT` - Server port (default: 8000)

## Architecture

This is a **bridge service** that translates between Anthropic-style API requests and the Toqan API. The service provides two main endpoints:

### Core Components

**Fastify Server** (`src/server.ts`, `src/index.ts`)
- HTTP server with multipart file upload support
- Configured with logging and CORS-ready setup

**Routes Handler** (`src/routes.ts`)
- `/v1/complete` - Synchronous completion endpoint with polling
- `/v1/complete/stream` - Server-sent events (SSE) streaming endpoint  
- `/v1/files` - File upload endpoint that proxies to Toqan
- `/v1/_find_conversation` - Direct proxy to Toqan's find_conversation
- `/healthz` - Health check endpoint

**Toqan Client** (`src/toqanClient.ts`)
- Axios-based HTTP client for Toqan API integration
- Handles conversation creation, continuation, answer polling, and file uploads
- Uses form-data for multipart file uploads to Toqan

**Redis Client** (`src/redisClient.ts`)
- IORedis singleton for conversation state management
- Maps client session IDs to Toqan conversation IDs
- Implements distributed locking for conversation creation

### Key Design Patterns

**Session Mapping**: Client `conversation_id` → Redis hash map → Toqan `conversation_id`
- Allows clients to maintain persistent conversations across requests
- Uses Redis locks to prevent race conditions during conversation creation

**Polling to Streaming**: The service polls Toqan's `/get_answer` endpoint and simulates streaming via SSE
- `/v1/complete` returns final result after polling completes
- `/v1/complete/stream` sends incremental updates as SSE events with delta text

**Request Flow**:
1. Extract user message from Anthropic-style request format
2. Map session ID to Toqan conversation (create if needed)
3. Send message to Toqan API
4. Poll for answer completion with configurable intervals/timeout
5. Return response in Anthropic-compatible format

## Testing

Tests use Jest with ts-jest preset and 20-second timeout. The test suite includes:
- Nock for mocking Toqan API responses  
- Fastify's `server.inject()` for HTTP testing
- Tests require Redis running (use `docker-compose up redis`)

## Important Notes

- TypeScript strict mode enabled - all type errors must be resolved
- File uploads are proxied directly to Toqan with multipart form-data
- No rate limiting, circuit breakers, or retry logic implemented
- Streaming is simulated via polling - not true real-time streaming
- Redis is required for session state management