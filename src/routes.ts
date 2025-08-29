import { FastifyInstance } from "fastify";
import { getRedis } from "./redisClient";
import { createConversation, continueConversation, getAnswer, uploadFile, findConversation } from "./toqanClient";
import { AnthropicRequest, AnthropicCompletionResponse, AnthropicResponse, ContentBlock } from "./types";
import { SmartRequestHandler, SmartRequestOptions } from "./smartRequestHandler";
import { smartEstimateTokens, exceedsTokenLimit } from "./utils/tokenEstimation";
import fs from "fs";
import path from "path";

const MAP_KEY = "toqan:conv_map";
const META_PREFIX = "toqan:meta:";
const LOCK_PREFIX = "toqan:lock:";

// Debug logging helper
const logFile = path.join(process.cwd(), 'debug.log');
function debugLog(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}${data ? ` | Data: ${JSON.stringify(data)}` : ''}\n`;
  fs.appendFileSync(logFile, logEntry);
}

export default async function routes(fastify: FastifyInstance) {
  const redis = getRedis();

  // Smart request handler configuration
  const smartRequestOptions: SmartRequestOptions = {
    strategy: (process.env.FORCE_STRATEGY as any) || 'auto',
    pollTimeout: parseInt(process.env.POLL_TIMEOUT || '30000'),
    maxPollAttempts: parseInt(process.env.MAX_POLL_ATTEMPTS || '240')
  };
  
  const smartHandler = new SmartRequestHandler(smartRequestOptions);

  // Smart request handling helper
  async function handleWithSmartRequest(
    user_message: string, 
    sessionId: string,
    options: Partial<SmartRequestOptions> = {}
  ): Promise<{ answer: string; conversationId: string; requestId: string; strategy: string }> {
    const tokens = smartEstimateTokens(user_message);
    debugLog('SMART_REQUEST_START', { tokens, sessionId, messageLength: user_message.length });

    // Check if we should use smart handling
    if (exceedsTokenLimit(user_message, 115000)) {
      console.log(`🧠 Using smart request handling for ${tokens} tokens`);
      
      const result = await smartHandler.handleLargeRequest(user_message, {
        ...options,
        sessionId
      });
      
      debugLog('SMART_REQUEST_COMPLETE', { 
        strategy: result.strategy, 
        tokens: result.totalInputTokens,
        responseTokens: result.totalResponseTokens,
        processingTime: result.totalTime,
        chunksProcessed: result.chunksProcessed,
        fileId: result.fileId
      });

      return {
        answer: result.answer,
        conversationId: result.conversationId,
        requestId: result.requestId,
        strategy: result.strategy
      };
    } else {
      console.log(`📤 Using direct request for ${tokens} tokens`);
      // Use existing logic for smaller requests
      let toqanConv = await redis.hget(MAP_KEY, sessionId);
      let request_id: string | undefined = undefined;

      if (!toqanConv) {
        const lockKey = LOCK_PREFIX + sessionId;
        const locked = await acquireLock(lockKey);
        try {
          toqanConv = await redis.hget(MAP_KEY, sessionId);
          if (!toqanConv) {
            const createResp = await createConversation(user_message);
            toqanConv = createResp.conversation_id;
            request_id = createResp.request_id;
            if (!toqanConv) throw new Error("toqan no conversation_id");
            await redis.hset(MAP_KEY, sessionId, toqanConv);
            await redis.set(META_PREFIX + toqanConv, JSON.stringify({ created_at: new Date().toISOString(), sessionId }));
          }
        } finally {
          if (locked) await releaseLock(lockKey);
        }
      } else {
        const cont = await continueConversation(toqanConv, user_message);
        request_id = cont.request_id;
      }

      const final = await pollAnswer(toqanConv, request_id);
      
      return {
        answer: final.answer || "",
        conversationId: toqanConv,
        requestId: request_id!,
        strategy: 'direct'
      };
    }
  }

  // Authentication middleware
  function validateApiKey(request: any, reply: any, next: any) {
    const headers = request.headers;
    const authHeader = headers['x-api-key'] || headers['authorization'] || headers['anthropic-api-key'];
    const envApiKey = process.env.ANTHROPIC_API_KEY || process.env.TOQAN_API_KEY;
    
    // Extract token from Bearer if present
    let providedKey = authHeader;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      providedKey = authHeader.substring(7);
    }
    
    // Skip validation - bridge accepts all requests from Claude Code
    next();
  }

  async function acquireLock(key: string, ttl = 10) {
    const ok = await redis.set(key, "1", "EX", ttl, "NX");
    return ok === "OK";
  }
  async function releaseLock(key: string) {
    await redis.del(key);
  }

  // Filter thinking tags and internal reasoning from AI responses
  function cleanAiResponse(text: string): string {
    if (!text) return text;
    
    // Remove <think>...</think> blocks (case insensitive, multiline)
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    
    // Remove <thinking>...</thinking> blocks  
    cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    
    // Clean up extra whitespace and newlines
    cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
    
    return cleaned;
  }

  // Tool execution framework - detects USE_TOOL patterns and converts to Anthropic tool_use blocks
  function parseToolsFromResponse(response: string): { textContent: string; toolUses: any[] } {
    if (!response) {
      return { textContent: "", toolUses: [] };
    }

    const toolPattern = /USE_TOOL\(([^,]+),\s*(\{[^}]+\})\)/g;
    const toolUses: any[] = [];
    let match;
    
    console.log('🔍 Scanning response for tool usage patterns...');
    
    while ((match = toolPattern.exec(response)) !== null) {
      const [fullMatch, toolName, jsonParams] = match;
      
      try {
        const params = JSON.parse(jsonParams);
        const toolUseId = `toolu_${Math.random().toString(36).slice(2, 15)}`;
        
        const toolUse = {
          type: "tool_use",
          id: toolUseId,
          name: toolName.trim(),
          input: params
        };
        
        toolUses.push(toolUse);
        console.log(`🔧 Detected tool use: ${toolName.trim()} with params:`, params);
        
      } catch (error) {
        console.warn(`⚠️ Failed to parse tool parameters for ${toolName}:`, jsonParams, error);
      }
    }

    // Remove USE_TOOL patterns from text content and clean up
    const textContent = response
      .replace(toolPattern, '')
      .replace(/\n\s*\n/g, '\n')
      .trim();

    console.log(`📄 Tool parsing complete: ${toolUses.length} tools detected, ${textContent.length} chars remaining`);
    
    return { textContent, toolUses };
  }

  // Convert response to Anthropic format with tool support
  function formatAnthropicResponse(toqanResponse: string, model: string): any {
    const cleaned = cleanAiResponse(toqanResponse);
    const { textContent, toolUses } = parseToolsFromResponse(cleaned);
    
    const content: any[] = [];
    
    // Add text content if present
    if (textContent) {
      content.push({
        type: "text",
        text: textContent
      });
    }
    
    // Add tool uses
    content.push(...toolUses);
    
    const response = {
      id: `msg_${Math.random().toString(36).slice(2)}`,
      type: "message",
      role: "assistant",
      content: content.length > 0 ? content : [{ type: "text", text: "" }],
      model: model,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0
      }
    };

    if (toolUses.length > 0) {
      console.log(`🎯 Created Anthropic response with ${toolUses.length} tool uses and ${textContent.length} text chars`);
    }

    return response;
  }

  // Process tools and inject them as context for Toqan AI
  function processToolsForToqan(tools?: Tool[], userMessage?: string): string {
    if (!tools || tools.length === 0) return userMessage || '';
    
    console.log(`🔧 Injecting ${tools.length} tools into context for Toqan AI`);
    
    let toolsContext = `System: You have access to the following tools. When you need to use a tool, respond with: USE_TOOL(tool_name, {"param": "value"})

Available Tools:
`;
    
    tools.forEach(tool => {
      toolsContext += `- ${tool.name}: ${tool.description}\n`;
      if (tool.input_schema?.properties) {
        const params = Object.keys(tool.input_schema.properties).join(', ');
        toolsContext += `  Parameters: ${params}\n`;
      }
    });
    
    toolsContext += `\nUser Request: ${userMessage || ''}`;
    
    return toolsContext;
  }

  async function processFiles(content: ContentBlock[]): Promise<{ fileIds: string[], textContent: string }> {
    const fileIds: string[] = [];
    let textContent = "";

    debugLog('PROCESS_FILES_START', {
      timestamp: new Date().toISOString(),
      blockCount: content.length,
      blocks: content.map((block, i) => ({
        index: i,
        type: block.type,
        keys: Object.keys(block),
        preview: JSON.stringify(block).substring(0, 500)
      }))
    });

    for (const [blockIndex, block] of content.entries()) {
      debugLog('PROCESSING_BLOCK', {
        blockIndex,
        type: block.type,
        allKeys: Object.keys(block),
        blockData: block
      });
      if (block.type === "image" && block.source?.type === "base64" && block.source.data) {
        try {
          // Decodificar base64 para Buffer
          const buffer = Buffer.from(block.source.data, 'base64');
          
          // Determinar extensão do arquivo baseado no media_type
          const mediaType = block.source.media_type || 'image/png';
          const extension = mediaType.split('/')[1] || 'png';
          const filename = `image.${extension}`;
          
          debugLog('PROCESSING_IMAGE', { 
            mediaType, 
            filename, 
            bufferSize: buffer.length 
          });
          
          // Fazer upload para Toqan
          const uploadResult = await uploadFile(buffer, filename, mediaType);
          const fileId = uploadResult.file_id || uploadResult.id;
          
          if (fileId) {
            fileIds.push(fileId);
            debugLog('IMAGE_UPLOADED', { fileId, filename });
          } else {
            console.warn('⚠️ Upload retornou resposta sem file_id:', uploadResult);
          }
        } catch (error: any) {
          console.error('❌ Erro ao fazer upload de imagem:', error);
          debugLog('IMAGE_UPLOAD_ERROR', { 
            error: error.message,
            mediaType: block.source.media_type 
          });
        }
      } else if (block.type === "document" && block.source?.type === "base64" && block.source.data) {
        try {
          // Processar documentos (PDF, etc.)
          const buffer = Buffer.from(block.source.data, 'base64');
          const mediaType = block.source.media_type || 'application/pdf';
          const extension = mediaType === 'application/pdf' ? 'pdf' : 'doc';
          const filename = `document.${extension}`;
          
          debugLog('PROCESSING_DOCUMENT', { 
            mediaType, 
            filename, 
            bufferSize: buffer.length 
          });
          
          const uploadResult = await uploadFile(buffer, filename, mediaType);
          const fileId = uploadResult.file_id || uploadResult.id;
          
          if (fileId) {
            fileIds.push(fileId);
            debugLog('DOCUMENT_UPLOADED', { fileId, filename });
          } else {
            console.warn('⚠️ Upload retornou resposta sem file_id:', uploadResult);
          }
        } catch (error: any) {
          console.error('❌ Erro ao fazer upload de documento:', error);
          debugLog('DOCUMENT_UPLOAD_ERROR', { 
            error: error.message,
            mediaType: block.source.media_type 
          });
        }
      } else if (block.type === "text" && block.text) {
        textContent += block.text + " ";
        debugLog('TEXT_BLOCK_PROCESSED', { 
          blockIndex,
          textLength: block.text.length,
          textPreview: block.text.substring(0, 200),
          fullText: block.text
        });
      } else {
        // Log TODOS os blocos não reconhecidos com conteúdo completo
        console.log(`⚠️ Unrecognized content block:`, {
          blockIndex,
          type: block.type,
          hasText: !!block.text,
          hasSource: !!block.source,
          keys: Object.keys(block),
          fullBlock: block // Ver tudo que tem no block
        });
        debugLog('UNRECOGNIZED_CONTENT_BLOCK', {
          blockIndex,
          type: block.type,
          keys: Object.keys(block),
          fullBlock: block, // Log completo do block para análise
          attemptTextExtraction: true
        });
        
        // Tentar extrair texto de qualquer campo que pareça texto
        if (block.text) {
          textContent += block.text + " ";
          console.log(`  → Extracted text from unrecognized block: ${block.text.substring(0, 100)}...`);
          debugLog('TEXT_EXTRACTED_FROM_UNRECOGNIZED_BLOCK', {
            blockIndex,
            type: block.type,
            textLength: block.text.length,
            extractedText: block.text
          });
        }
      }
    }

    const finalResult = { 
      fileIds, 
      textContent: textContent.trim() 
    };

    debugLog('PROCESS_FILES_COMPLETE', {
      timestamp: new Date().toISOString(),
      totalBlocks: content.length,
      filesUploaded: fileIds.length,
      fileIds: fileIds,
      textLength: finalResult.textContent.length,
      extractedText: finalResult.textContent,
      success: true
    });

    return finalResult;
  }

  async function pollAnswer(convId: string, requestId?: string, pollInterval = Number(process.env.POLL_INTERVAL || 0.5), timeout = Number(process.env.POLL_TIMEOUT || 30)) {
    const deadline = Date.now() + timeout * 1000;
    let last: any = { status: "pending", answer: "" };
    while (Date.now() < deadline) {
      const r = await getAnswer(convId, requestId);
      const status = (r.status || "").toString().toLowerCase();
      const ans = r.answer || "";
      if (["finished", "done", "completed"].includes(status) && ans) return r;
      if (ans && ans !== last.answer) last = r;
      await new Promise((res) => setTimeout(res, pollInterval * 1000));
    }
    return last;
  }

  fastify.post("/v1/complete", async (req, reply) => {
    const body = req.body as AnthropicRequest;
    const sessionId = body.conversation_id || `anon-${Date.now()}`;
    const userMsgs = (body.messages || []).filter(m => m.role === "user");
    if (!userMsgs.length) return reply.status(400).send({ error: "no user message" });
    const lastUserMsg = userMsgs[userMsgs.length - 1];
    const rawUserMessage = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : 
      Array.isArray(lastUserMsg.content) ? 
        lastUserMsg.content.filter(b => b.type === 'text').map(b => b.text).join(' ') : 
        String(lastUserMsg.content);
    
    // Process tools and inject them into the user message for Toqan AI
    const user_message = processToolsForToqan(body.tools, rawUserMessage);

    // Check for forced strategy from headers
    const forceStrategy = req.headers['x-force-strategy'] as SmartRequestOptions['strategy'];
    
    try {
      const result = await handleWithSmartRequest(user_message, sessionId, {
        strategy: forceStrategy || 'auto'
      });

      // Store conversation mapping for traditional clients
      await redis.hset(MAP_KEY, sessionId, result.conversationId);
      await redis.set(META_PREFIX + result.conversationId, JSON.stringify({ 
        created_at: new Date().toISOString(), 
        sessionId,
        strategy: result.strategy 
      }));

      const response: AnthropicCompletionResponse = {
        id: `msg_${Math.random().toString(36).slice(2)}`,
        object: "completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model || "claude-3-sonnet-20240229",
        completion: cleanAiResponse(result.answer),
        stop_reason: "end_turn",
        usage: {
          prompt_tokens: 0, // Toqan doesn't provide token counts
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      
      return reply.send(response);
      
    } catch (error: any) {
      console.error('Smart request handling failed:', error);
      return reply.status(502).send({ 
        error: "processing_failed", 
        message: error.message,
        strategy_used: "smart_handling"
      });
    }
  });

  fastify.post("/v1/complete/stream", async (req, reply) => {
    const body = req.body as AnthropicRequest;
    const sessionId = body.conversation_id || `anon-${Date.now()}`;
    const userMsgs = (body.messages || []).filter(m => m.role === "user");
    if (!userMsgs.length) return reply.status(400).send({ error: "no user message" });
    const lastUserMsg = userMsgs[userMsgs.length - 1];
    const rawUserMessage = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : 
      Array.isArray(lastUserMsg.content) ? 
        lastUserMsg.content.filter(b => b.type === 'text').map(b => b.text).join(' ') : 
        String(lastUserMsg.content);
    
    // Process tools and inject them into the user message for Toqan AI
    const user_message = processToolsForToqan(body.tools, rawUserMessage);

    // Check for forced strategy from headers
    const forceStrategy = req.headers['x-force-strategy'] as SmartRequestOptions['strategy'];
    
    // SSE setup
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    try {
      // For streaming, we need to handle smart requests differently
      // since chunking and file uploads don't stream naturally
      const tokens = smartEstimateTokens(user_message);
      
      if (exceedsTokenLimit(user_message, 115000)) {
        console.log(`🌊 Smart streaming for ${tokens} tokens - using simulated streaming`);
        
        // Send initial progress message
        reply.raw.write(`data: ${JSON.stringify({ delta: `[Processing large context: ${tokens} tokens...]\n\n` })}\n\n`);
        
        const result = await smartHandler.handleLargeRequest(user_message, {
          strategy: forceStrategy || 'auto',
          sessionId
        });

        // Store conversation mapping
        await redis.hset(MAP_KEY, sessionId, result.conversationId);
        await redis.set(META_PREFIX + result.conversationId, JSON.stringify({ 
          created_at: new Date().toISOString(), 
          sessionId,
          strategy: result.strategy 
        }));

        // Send the final answer as a stream chunk
        const cleanAnswer = cleanAiResponse(result.answer);
        reply.raw.write(`data: ${JSON.stringify({ delta: cleanAnswer })}\n\n`);
        
      } else {
        console.log(`🌊 Direct streaming for ${tokens} tokens`);
        
        // Use traditional streaming logic for smaller requests
        const redisInst = redis;
        let toqanConv = await redisInst.hget(MAP_KEY, sessionId);
        let request_id: string | undefined = undefined;

        if (!toqanConv) {
          const lockKey = LOCK_PREFIX + sessionId;
          const locked = await acquireLock(lockKey);
          try {
            toqanConv = await redisInst.hget(MAP_KEY, sessionId);
            if (!toqanConv) {
              const createResp = await createConversation(user_message, body.file_ids?.map(id => ({ id })));
              toqanConv = createResp.conversation_id;
              request_id = createResp.request_id;
              if (!toqanConv) {
                reply.raw.write(`data: ${JSON.stringify({ error: "Failed to create conversation" })}\n\n`);
                reply.raw.end();
                return;
              }
              await redisInst.hset(MAP_KEY, sessionId, toqanConv);
              await redisInst.set(META_PREFIX + toqanConv, JSON.stringify({ created_at: new Date().toISOString(), sessionId }));
            }
          } finally {
            if (locked) await releaseLock(lockKey);
          }
        } else {
          const cont = await continueConversation(toqanConv, user_message);
          request_id = cont.request_id;
        }

        // Traditional streaming polling
        let sent = "";
        const pollInterval = Number(process.env.POLL_INTERVAL || 0.5) * 1000;
        const timeout = Number(process.env.POLL_TIMEOUT || 30) * 1000;
        const deadline = Date.now() + timeout;

        while (Date.now() < deadline) {
          const r = await getAnswer(toqanConv, request_id);
          const ans = r.answer || "";
          const status = (r.status || "").toString().toLowerCase();
          if (ans && ans !== sent) {
            const delta = ans.slice(sent.length);
            sent = ans;
            reply.raw.write(`data: ${JSON.stringify({ delta })}\n\n`);
          }
          if (["finished", "done", "completed"].includes(status) && ans) break;
          await new Promise((res) => setTimeout(res, pollInterval));
        }
      }

      // Send completion signal
      reply.raw.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      
    } catch (error: any) {
      console.error('Smart streaming failed:', error);
      reply.raw.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    } finally {
      try { reply.raw.end(); } catch {}
    }
    return reply;
  });

  // files
  fastify.post("/v1/files", async (req, reply) => {
    // fastify-multipart: parse single file field 'file'
    const mp = await req.file();
    if (!mp) return reply.code(400).send({ error: "file required" });
    const buffer = await mp.toBuffer();
    const resp = await uploadFile(buffer, mp.filename, mp.mimetype || "application/octet-stream");
    const fileId = resp.file_id || resp.id;
    if (!fileId) return reply.code(502).send({ error: "unexpected toqan upload response", raw: resp });
    return reply.send({ id: fileId, toqan_raw: resp });
  });

  // Modern Messages API endpoint
  fastify.post("/v1/messages", async (req, reply) => {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`🔄 ${timestamp} - Claude Code Request: POST /v1/messages`);
    
    const body = req.body as AnthropicRequest;
    
    // Detectar se é uma chamada de título automática
    const isAutoTitle = body.messages?.some(m => 
      typeof m.content === 'string' && 
      (m.content.includes('write a 5-10 word title') || 
       m.content.includes('title the following conversation'))
    );
    
    if (isAutoTitle) {
      console.log(`📋 Auto-title request detected - skipping detailed logging`);
    }
    
    // Log completo da request para análise (apenas se não for auto-title)
    if (!isAutoTitle) {
      console.log('\n═══════════════ CLAUDE CODE REQUEST LOG ═══════════════');
    }
    console.log(`⏰ Timestamp: ${timestamp}`);
    console.log(`🔑 Headers:`, {
      'content-type': req.headers['content-type'],
      'user-agent': req.headers['user-agent'],
      'x-api-key': req.headers['x-api-key'] ? '***' : undefined,
      'authorization': req.headers['authorization'] ? '***' : undefined,
    });
    console.log(`📨 Request Body Structure:`);
    console.log(`  - Model: ${body.model}`);
    console.log(`  - Messages count: ${body.messages?.length || 0}`);
    console.log(`  - Conversation ID: ${body.conversation_id || 'none'}`);
    console.log(`  - File IDs: ${body.file_ids?.length || 0} files`);
    console.log(`  - Tools: ${body.tools?.length || 0} tools available`);
    
    // Log tools details if any are provided
    if (body.tools && body.tools.length > 0) {
      console.log(`🛠️ Available Tools:`);
      body.tools.forEach((tool, index) => {
        console.log(`  [${index}] ${tool.name}: ${tool.description}`);
      });
    }
    
    if (body.messages && body.messages.length > 0) {
      const lastUserMsg = body.messages.filter(m => m.role === 'user').pop();
      if (lastUserMsg) {
        console.log(`📝 Last User Message:`);
        console.log(`  - Content Type: ${typeof lastUserMsg.content}`);
        
        if (typeof lastUserMsg.content === 'string') {
          const preview = lastUserMsg.content.length > 200 
            ? lastUserMsg.content.substring(0, 200) + '...[truncated]'
            : lastUserMsg.content;
          console.log(`  - Content Preview: "${preview}"`);
          console.log(`  - Content Length: ${lastUserMsg.content.length} chars`);
          
          // Detectar se contém código
          const hasCode = lastUserMsg.content.includes('```') || 
                         lastUserMsg.content.includes('function ') ||
                         lastUserMsg.content.includes('class ') ||
                         lastUserMsg.content.includes('import ') ||
                         lastUserMsg.content.includes('export ') ||
                         lastUserMsg.content.includes('const ') ||
                         lastUserMsg.content.includes('let ') ||
                         lastUserMsg.content.includes('var ');
          console.log(`  - Contains Code: ${hasCode ? '✅ YES' : '❌ NO'}`);
          
        } else if (Array.isArray(lastUserMsg.content)) {
          console.log(`  - Content Blocks: ${lastUserMsg.content.length}`);
          (lastUserMsg.content as any[]).forEach((block: any, index: number) => {
            console.log(`    [${index}] Type: ${block.type}`);
            if (block.type === 'text') {
              const preview = block.text?.length > 100 
                ? block.text.substring(0, 100) + '...[truncated]'
                : block.text;
              console.log(`    [${index}] Text Preview: "${preview}"`);
              console.log(`    [${index}] Text Length: ${block.text?.length || 0} chars`);
            } else if (block.type === 'image') {
              console.log(`    [${index}] Media Type: ${block.source?.media_type}`);
              console.log(`    [${index}] Data Length: ${block.source?.data?.length || 0} chars`);
            } else if (block.type === 'document') {
              console.log(`    [${index}] Media Type: ${block.source?.media_type}`);
              console.log(`    [${index}] Data Length: ${block.source?.data?.length || 0} chars`);
            }
          });
        }
      }
    }
    if (!isAutoTitle) {
      console.log('═══════════════════════════════════════════════════════\n');
    }
    
    // Log ULTRA-DETALHADO para arquivo debug.log
    const ultraDetailedLogData = {
      timestamp,
      isAutoTitle,
      requestInfo: {
        method: 'POST',
        url: '/v1/messages',
        contentLength: req.headers['content-length'],
        userAgent: req.headers['user-agent'],
        allHeaders: req.headers, // TODOS os headers
        hasApiKey: !!req.headers['x-api-key'],
        hasAuth: !!req.headers['authorization']
      },
      requestBody: {
        // Estrutura básica
        model: body.model,
        max_tokens: body.max_tokens,
        temperature: body.temperature,
        stream: body.stream,
        system: body.system,
        tools: body.tools,
        metadata: body.metadata,
        
        // Mensagens COMPLETAS
        messageCount: body.messages?.length || 0,
        messagesDetailed: body.messages?.map((msg, index) => ({
          index,
          role: msg.role,
          contentType: typeof msg.content,
          contentStructure: Array.isArray(msg.content) 
            ? msg.content.map((block, blockIndex) => ({
                blockIndex,
                type: block.type,
                keys: Object.keys(block),
                textLength: block.text?.length || 0,
                textPreview: block.text ? block.text.substring(0, 500) : undefined,
                hasSource: !!block.source,
                sourceType: block.source?.type,
                sourceMediaType: block.source?.media_type,
                sourceDataLength: block.source?.data?.length || 0,
                cacheControl: block.cache_control,
                fullBlock: block // BLOCK COMPLETO para análise
              }))
            : {
                isString: true,
                length: typeof msg.content === 'string' ? msg.content.length : 0,
                preview: typeof msg.content === 'string' ? msg.content.substring(0, 1000) : 'non-string',
                fullContent: msg.content // CONTEÚDO COMPLETO se for string
              },
          name: msg.name,
          fullMessage: msg // MENSAGEM COMPLETA
        })) || [],
        
        // Outros campos
        conversationId: body.conversation_id,
        fileIdsCount: body.file_ids?.length || 0,
        fileIds: body.file_ids,
        
        // REQUEST COMPLETA RAW para debug máximo
        rawRequestBody: body
      },
      
      // Análise específica da última mensagem do usuário
      lastUserMessageAnalysis: (() => {
        const lastUserMsg = body.messages?.filter(m => m.role === 'user').pop();
        if (!lastUserMsg) return null;
        
        return {
          exists: true,
          contentType: typeof lastUserMsg.content,
          isArray: Array.isArray(lastUserMsg.content),
          
          // Se for array de content blocks
          ...(Array.isArray(lastUserMsg.content) ? {
            blockCount: lastUserMsg.content.length,
            blockAnalysis: lastUserMsg.content.map((block, i) => ({
              index: i,
              type: block.type,
              allKeys: Object.keys(block),
              textExists: !!block.text,
              textLength: block.text?.length || 0,
              textContent: block.text, // TEXTO COMPLETO
              sourceExists: !!block.source,
              sourceStructure: block.source ? {
                type: block.source.type,
                mediaType: block.source.media_type,
                dataLength: block.source.data?.length || 0,
                fileId: block.source.file_id
              } : null,
              cacheControl: block.cache_control,
              completeBlock: block // BLOCK INTEIRO
            })),
            extractedText: lastUserMsg.content
              .filter(b => b.type === 'text' && b.text)
              .map(b => b.text)
              .join(' '),
            hasCodeBlocks: lastUserMsg.content.some(b => 
              b.text && (
                b.text.includes('```') ||
                b.text.includes('function ') ||
                b.text.includes('class ') ||
                b.text.includes('import ') ||
                b.text.includes('def ') ||
                b.text.includes('const ') ||
                b.text.includes('let ') ||
                b.text.includes('var ')
              )
            )
          } : {}),
          
          // Se for string simples
          ...(typeof lastUserMsg.content === 'string' ? {
            stringLength: lastUserMsg.content.length,
            stringPreview: lastUserMsg.content.substring(0, 500),
            fullStringContent: lastUserMsg.content, // CONTEÚDO COMPLETO
            hasCode: lastUserMsg.content.includes('```') ||
                    lastUserMsg.content.includes('function ') ||
                    lastUserMsg.content.includes('class ') ||
                    lastUserMsg.content.includes('import ') ||
                    lastUserMsg.content.includes('def ') ||
                    lastUserMsg.content.includes('const ') ||
                    lastUserMsg.content.includes('let ') ||
                    lastUserMsg.content.includes('var ')
          } : {})
        };
      })()
    };

    debugLog('ULTRA_DETAILED_CLAUDE_REQUEST', ultraDetailedLogData);
    
    try {
    const sessionId = body.conversation_id || `session-${Date.now()}`;
    const userMsgs = (body.messages || []).filter(m => m.role === "user");
    if (!userMsgs.length) return reply.status(400).send({ error: "No user message found" });
    
    const lastUserMsg = userMsgs[userMsgs.length - 1];
    let user_message: string;
    let fileIds: string[] = [];
    
    // Handle different content formats from Claude Code
    if (typeof lastUserMsg.content === 'string') {
      user_message = lastUserMsg.content;
    } else if (Array.isArray(lastUserMsg.content)) {
      console.log('🔍 Processing content blocks with potential files...');
      debugLog('CONTENT_BLOCKS_DETECTED', { 
        blockCount: lastUserMsg.content.length,
        blockTypes: lastUserMsg.content.map((b: any) => b.type)
      });
      
      // Processar arquivos e extrair texto com LOG DETALHADO
      console.log(`🔍 Processing ${lastUserMsg.content.length} content blocks...`);
      
      // Log ultra-detalhado do processamento
      const detailedProcessingLog = {
        timestamp: new Date().toISOString(),
        inputBlocks: lastUserMsg.content.map((block, i) => ({
          index: i,
          type: block.type,
          keys: Object.keys(block),
          textLength: block.text?.length || 0,
          textPreview: block.text?.substring(0, 200),
          fullTextContent: block.text, // TEXTO COMPLETO de cada block
          hasSource: !!block.source,
          sourceDetails: block.source,
          fullBlock: block // BLOCK COMPLETO
        }))
      };
      
      debugLog('CONTENT_BLOCKS_PROCESSING_START', detailedProcessingLog);
      
      const processResult = await processFiles(lastUserMsg.content as ContentBlock[]);
      user_message = processResult.textContent;
      fileIds = processResult.fileIds;
      
      // Log do resultado do processamento
      const processingResultLog = {
        timestamp: new Date().toISOString(),
        result: {
          filesUploaded: fileIds.length,
          fileIds: fileIds,
          textExtracted: user_message,
          textLength: user_message.length,
          originalBlockCount: lastUserMsg.content.length
        },
        analysis: {
          hasText: !!user_message,
          hasFiles: fileIds.length > 0,
          blocksProcessed: lastUserMsg.content.length,
          extractionSuccessful: user_message.length > 0
        }
      };
      
      debugLog('CONTENT_BLOCKS_PROCESSING_RESULT', processingResultLog);
      
      console.log(`📎 Processing result:`);
      console.log(`  - Files uploaded: ${fileIds.length}`);
      console.log(`  - Text extracted: ${user_message.length} chars`);
      console.log(`  - Text preview: "${user_message.substring(0, 200)}${user_message.length > 200 ? '...' : ''}"`);
      
      // Se não há texto, mas há arquivos, criar uma mensagem padrão
      if (!user_message && fileIds.length > 0) {
        user_message = "Please analyze the uploaded file(s).";
        console.log(`  - Using default message for files without text`);
        debugLog('USING_DEFAULT_MESSAGE_FOR_FILES', { fileCount: fileIds.length });
      }
      
      // Apply tools processing to the final user message
      user_message = processToolsForToqan(body.tools, user_message);
      
      // Alerta se texto estiver vazio mas havia content blocks
      if (!user_message && lastUserMsg.content.length > 0) {
        console.log(`⚠️ WARNING: ${lastUserMsg.content.length} content blocks but no text extracted!`);
        debugLog('WARNING_NO_TEXT_EXTRACTED', { 
          blockCount: lastUserMsg.content.length,
          blocks: lastUserMsg.content
        });
      }
    } else {
      user_message = String(lastUserMsg.content);
    }
    
    if (!user_message) {
      return reply.status(400).send({ error: "No valid user message content found" });
    }
    let toqanConv = await redis.hget(MAP_KEY, sessionId);
    let request_id: string | undefined = undefined;

    if (!toqanConv) {
      const lockKey = LOCK_PREFIX + sessionId;
      const locked = await acquireLock(lockKey);
      try {
        toqanConv = await redis.hget(MAP_KEY, sessionId);
        if (!toqanConv) {
          // Usar fileIds processados ou file_ids do body como fallback
          const filesToSend = fileIds.length > 0 
            ? fileIds.map(id => ({ id }))
            : body.file_ids?.map(id => ({ id }));
            
          console.log(`🚀 Creating new Toqan conversation with ${filesToSend?.length || 0} files`);
          const createResp = await createConversation(user_message, filesToSend);
          toqanConv = createResp.conversation_id;
          request_id = createResp.request_id;
          if (!toqanConv) return reply.status(502).send({ error: "toqan no conversation_id" });
          await redis.hset(MAP_KEY, sessionId, toqanConv);
          await redis.set(META_PREFIX + toqanConv, JSON.stringify({ created_at: new Date().toISOString(), sessionId }));
        }
      } finally {
        if (locked) await releaseLock(lockKey);
      }
    } else {
      console.log(`🔄 Continuing Toqan conversation: ${toqanConv}`);
      // Enviar arquivos se houver
      const filesToSend = fileIds.length > 0 ? fileIds.map(id => ({ id })) : undefined;
      if (filesToSend) {
        console.log(`📎 Continuing conversation with ${filesToSend.length} new files`);
      }
      const cont = await continueConversation(toqanConv, user_message, filesToSend);
      request_id = cont.request_id;
      console.log(`📨 Message sent to Toqan, polling for response...`);
    }

        const final = await pollAnswer(toqanConv, request_id);
      console.log(`📥 Received response from Toqan: ${final.status} (${(final.answer || '').length} chars)`);
      
      // Handle empty responses from Toqan API (likely due to credit limits or large requests)
      let toqanResponse = final.answer || "";
      if (!toqanResponse.trim() && user_message.length > 5000) {
        toqanResponse = "I received a large request but wasn't able to process it fully. This might be due to API limits. Please try breaking your request into smaller parts or asking a more specific question.";
        console.log(`⚠️ Empty response for large request (${user_message.length} chars) - providing fallback message`);
        debugLog('EMPTY_RESPONSE_FALLBACK', { 
          messageLength: user_message.length, 
          toqanStatus: final.status,
          toqanAnswerLength: (final.answer || '').length 
        });
      } else if (!toqanResponse.trim()) {
        toqanResponse = "I'm having trouble processing your request right now. Please try again or rephrase your question.";
        console.log(`⚠️ Empty response - providing generic fallback message`);
        debugLog('EMPTY_RESPONSE_GENERIC', { 
          messageLength: user_message.length, 
          toqanStatus: final.status,
          toqanAnswerLength: (final.answer || '').length 
        });
      }
      
      // Use the new tool execution framework to format the response
      const response = formatAnthropicResponse(toqanResponse, body.model || "claude-3-sonnet-20240229");
      
      // Update stop reason based on Toqan status
      response.stop_reason = final.status === "finished" ? "end_turn" : null;
      
      const endTime = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const responseLength = response.content.reduce((total: number, block: any) => {
        return total + (block.text?.length || 0);
      }, 0);
      console.log(`✅ ${endTime} - Response sent to Claude Code (${responseLength} chars, ${response.content.length} blocks)`);
      debugLog('CLAUDE_RESPONSE_SENT', { responseLength, blockCount: response.content.length, status: 'success' });
      
      return reply.send(response);
    } catch (error: any) {
      const errorTimestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
      console.error(`❌ ${errorTimestamp} - Error in Claude Code request:`, error);
      debugLog('CLAUDE_REQUEST_ERROR', { 
        error: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        stack: error.stack
      });
      
      // Return an appropriate error response in Anthropic format
      const errorResponse = {
        id: `msg_${Math.random().toString(36).slice(2)}`,
        type: "message",
        role: "assistant",
        content: [{
          type: "text",
          text: `I encountered an error while processing your request. ${error.response?.data?.error || error.message || 'Unknown error occurred.'}`
        }],
        model: body.model || "claude-3-sonnet-20240229",
        stop_reason: "error" as any,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0
        }
      };
      
      return reply.status(error.response?.status || 500).send(errorResponse);
    }
  });

  fastify.post("/v1/_find_conversation", async (req, reply) => {
    try {
      const body = req.body;
      const resp = await findConversation(body);
      return reply.send(resp);
    } catch (error: any) {
      console.error('Error in find_conversation:', error);
      debugLog('FIND_CONVERSATION_ERROR', { error: error.message, data: error.response?.data });
      return reply.status(error.response?.status || 500).send({
        error: error.response?.data?.error || error.message || 'Unknown error'
      });
    }
  });

  fastify.post("/v1/messages/count_tokens", async (req, reply) => {
    const body = req.body as AnthropicRequest;
    
    // Simple token counting approximation
    // Claude Sonnet 4 has ~200k context limit
    let totalTokens = 0;
    
    // Count tokens from messages
    if (body.messages) {
      for (const message of body.messages) {
        if (typeof message.content === 'string') {
          // Rough approximation: 1 token ≈ 4 characters
          totalTokens += Math.ceil(message.content.length / 4);
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'text' && block.text) {
              totalTokens += Math.ceil(block.text.length / 4);
            }
          }
        }
      }
    }
    
    // Count tokens from system prompt
    if (body.system) {
      if (typeof body.system === 'string') {
        totalTokens += Math.ceil(body.system.length / 4);
      }
    }
    
    // Count tokens from tools (tool definitions)
    if (body.tools) {
      for (const tool of body.tools) {
        const toolText = JSON.stringify(tool);
        totalTokens += Math.ceil(toolText.length / 4);
      }
    }
    
    return reply.send({
      input_tokens: totalTokens
    });
  });

  fastify.get("/healthz", async () => {
    return { status: "ok", toqan_base: process.env.TOQAN_BASE_URL || "" };
  });

  // Debug endpoint to check auth headers
  fastify.post("/v1/debug", async (req, reply) => {
    return {
      headers: req.headers,
      env_keys: {
        ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
        TOQAN_API_KEY: !!process.env.TOQAN_API_KEY
      },
      auth_headers: Object.keys(req.headers).filter(h => 
        h.toLowerCase().includes('auth') || h.toLowerCase().includes('key')
      )
    };
  });
}
