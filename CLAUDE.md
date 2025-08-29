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

### Core Configuration
Required environment variables (use .env file or docker-compose):
- `TOQAN_API_KEY` - API key for Toqan service authentication
- `TOQAN_BASE_URL` - Toqan API endpoint (defaults to https://api.coco.prod.toqan.ai/api)
- `REDIS_URL` - Redis connection string (defaults to redis://localhost:6379/0)
- `POLL_INTERVAL` - Polling interval in seconds for answer retrieval (default: 0.5)
- `POLL_TIMEOUT` - Maximum polling timeout in seconds (default: 30)
- `PORT` - Server port (default: 8000)

### Smart Request Handling Configuration
Advanced features for handling large contexts:
- `MAX_TOKENS_PER_CHUNK` - Maximum tokens per chunk for large messages (default: 115000)
- `FILE_UPLOAD_THRESHOLD` - Token threshold for using file upload strategy (default: 200000)
- `CHUNK_TIMEOUT_MULTIPLIER` - Multiplier for timeout when processing chunks (default: 2.0)
- `ENABLE_SMART_CHUNKING` - Enable automatic chunking for large requests (default: true)
- `FORCE_STRATEGY` - Force specific strategy: direct|chunks|file|hybrid|auto (default: auto)
- `MAX_POLL_ATTEMPTS` - Maximum polling attempts per chunk (default: 240)

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
2. Analyze message size and determine optimal processing strategy
3. Apply smart request handling (chunking, file upload, or direct)
4. Map session ID to Toqan conversation (create if needed)
5. Send message(s) to Toqan API using selected strategy
6. Poll for answer completion with configurable intervals/timeout
7. Return response in Anthropic-compatible format

**Smart Request Handling** (`src/smartRequestHandler.ts`, `src/chunkingService.ts`, `src/fileUploadService.ts`)
- Automatically handles requests exceeding Toqan's 120K token limit
- Four processing strategies based on content size:
  - **Direct**: ≤115K tokens - standard processing
  - **Chunking**: 115K-200K tokens - split into multiple `continue_conversation` calls
  - **File Upload**: 200K-500K tokens - upload content as file attachment
  - **Hybrid**: >500K tokens - combination of file upload and chunking

## Testing

Tests use Jest with ts-jest preset. The test suite includes:

### Core Tests
- Basic API functionality with Nock for mocking Toqan API responses  
- Fastify's `server.inject()` for HTTP endpoint testing
- Redis integration tests (requires `docker-compose up redis`)

### Smart Request Handling Tests
- `tests/chunking-integration.test.ts` - End-to-end testing of all chunking strategies
- `tests/chunking-performance.test.ts` - Performance and stress testing
- `tests/context-limits.test.ts` - API limit discovery and validation
- Token estimation accuracy and strategy selection validation
- File upload functionality and cleanup testing

### Test Commands
- `yarn test` - Run all tests
- `yarn test tests/chunking-integration.test.ts` - Test chunking functionality
- `yarn test tests/chunking-performance.test.ts` - Performance benchmarks
- `yarn test tests/context-limits.test.ts` - API limit validation

## Usage

### Client Headers
The bridge supports optional client headers for controlling behavior:
- `X-Force-Strategy: direct|chunks|file|hybrid` - Override automatic strategy selection
- Standard Anthropic API headers are supported and translated appropriately

### Request Size Handling
The bridge automatically handles requests of any size:
- **≤115K tokens**: Processed directly through Toqan API
- **115K-200K tokens**: Automatically chunked using `continue_conversation`
- **200K+ tokens**: Uses file upload for optimal processing
- **500K+ tokens**: Hybrid approach combining file upload with chunking

### Monitoring and Debugging
- Processing strategy and token counts logged for each request
- Detailed timing information for performance analysis
- Error handling with strategy-specific error messages
- Debug logging available via environment configuration

## Troubleshooting

### Large Request Issues
- **Timeout errors**: Increase `MAX_POLL_ATTEMPTS` for very large contexts
- **Memory issues**: Large requests may require more heap space (`--max-old-space-size`)
- **Strategy selection**: Use `X-Force-Strategy` header to override automatic selection

### Performance Optimization
- Set `MAX_TOKENS_PER_CHUNK` to optimize chunk size for your use case
- Adjust `FILE_UPLOAD_THRESHOLD` based on your typical request patterns
- Monitor Redis memory usage for session management at scale

### Testing Large Contexts
Use the included test suites to validate behavior:
```bash
# Test chunking with various strategies
yarn test tests/chunking-integration.test.ts

# Performance benchmarking
yarn test tests/chunking-performance.test.ts

# Validate API limits
yarn test tests/context-limits.test.ts
```

## Important Notes

- TypeScript strict mode enabled - all type errors must be resolved
- Smart request handling is backward compatible - existing clients work unchanged  
- File uploads are automatically cleaned up after processing
- Streaming works with all processing strategies (simulated for chunked/file requests)
- Redis is required for session state management and conversation mapping
- Large context processing may take several minutes - ensure adequate timeouts