/**
 * Smart Request Handler for Toqan AI Bridge
 * 
 * Intelligently handles requests of any size using the optimal strategy:
 * - Direct: ≤115K tokens
 * - Chunking: 115K-200K tokens via continue_conversation
 * - File: >200K tokens via file upload
 * - Hybrid: >500K tokens via file + chunking
 */

import { createConversation, continueConversation, getAnswer } from './toqanClient';
import { ChunkingService, chunkText, calculateOptimalChunkSize } from './chunkingService';
import { FileUploadService, uploadTextAsFile, shouldUseFileUpload } from './fileUploadService';
import { smartEstimateTokens, getRecommendedStrategy } from './utils/tokenEstimation';
import { ProgressCallback, ProgressUpdate } from './progressStreamManager';

export interface SmartRequestOptions {
  /** Force a specific strategy instead of auto-detection */
  strategy?: 'direct' | 'chunks' | 'file' | 'hybrid' | 'auto';
  /** Timeout for each get_answer poll attempt in ms */
  pollTimeout?: number;
  /** Maximum polling attempts per chunk/request */
  maxPollAttempts?: number;
  /** Session ID for conversation continuity */
  sessionId?: string;
  /** Custom chunking options */
  chunkingOptions?: Parameters<typeof chunkText>[1];
  /** Custom file upload options */
  fileUploadOptions?: Parameters<typeof uploadTextAsFile>[1];
  /** Progress callback for streaming updates */
  progressCallback?: ProgressCallback;
}

export interface SmartRequestResult {
  /** Final conversation ID */
  conversationId: string;
  /** Final request ID */
  requestId: string;
  /** Strategy used for processing */
  strategy: 'direct' | 'chunks' | 'file' | 'hybrid';
  /** Final answer from Toqan */
  answer: string;
  /** Total input tokens processed */
  totalInputTokens: number;
  /** Total response tokens received */
  totalResponseTokens: number;
  /** Total processing time in milliseconds */
  totalTime: number;
  /** Number of chunks processed (if chunking was used) */
  chunksProcessed?: number;
  /** File ID if file upload was used */
  fileId?: string;
  /** Detailed breakdown of processing steps */
  processingSteps: ProcessingStep[];
}

export interface ProcessingStep {
  step: string;
  startTime: number;
  duration: number;
  success: boolean;
  tokens?: number;
  error?: string;
  conversationId?: string;
  requestId?: string;
}

/**
 * Smart request handler class
 */
export class SmartRequestHandler {
  private options: Required<Omit<SmartRequestOptions, 'sessionId' | 'chunkingOptions' | 'fileUploadOptions' | 'progressCallback'>> 
    & Pick<SmartRequestOptions, 'sessionId' | 'chunkingOptions' | 'fileUploadOptions' | 'progressCallback'>;

  constructor(options: SmartRequestOptions = {}) {
    this.options = {
      strategy: options.strategy ?? 'auto',
      pollTimeout: options.pollTimeout ?? 120000, // 2 minutes default
      maxPollAttempts: options.maxPollAttempts ?? 240, // 4 minutes total per chunk
      sessionId: options.sessionId,
      chunkingOptions: options.chunkingOptions,
      fileUploadOptions: options.fileUploadOptions,
      progressCallback: options.progressCallback
    };
  }

  /**
   * Process a large context request using the optimal strategy
   */
  public async handleLargeRequest(
    message: string,
    options: Partial<SmartRequestOptions> = {}
  ): Promise<SmartRequestResult> {
    const mergedOptions = { ...this.options, ...options };
    const startTime = Date.now();
    const processingSteps: ProcessingStep[] = [];
    const totalInputTokens = smartEstimateTokens(message);

    try {
      // Determine strategy
      const strategy = mergedOptions.strategy === 'auto' 
        ? getRecommendedStrategy(message)
        : mergedOptions.strategy;

      // Send initial progress update
      this.sendProgress(mergedOptions.progressCallback, {
        type: 'status',
        message: `Iniciando processamento com estratégia: ${strategy}`,
        step: 'strategy_selection'
      });

      this.addProcessingStep(processingSteps, 'Strategy Selection', startTime, 0, true, {
        tokens: totalInputTokens,
        additionalInfo: `Selected strategy: ${strategy}`
      });

      // Execute based on strategy
      let result: SmartRequestResult;

      switch (strategy) {
        case 'direct':
          result = await this.handleDirectRequest(message, mergedOptions, processingSteps);
          break;
        case 'chunks':
          result = await this.handleChunkedRequest(message, mergedOptions, processingSteps);
          break;
        case 'file':
          result = await this.handleFileRequest(message, mergedOptions, processingSteps);
          break;
        case 'hybrid':
          result = await this.handleHybridRequest(message, mergedOptions, processingSteps);
          break;
        default:
          throw new Error(`Unknown strategy: ${strategy}`);
      }

      result.totalTime = Date.now() - startTime;
      result.totalInputTokens = totalInputTokens;
      result.processingSteps = processingSteps;

      return result;

    } catch (error) {
      this.addProcessingStep(processingSteps, 'Error', startTime, Date.now() - startTime, false, {
        error: (error as Error).message
      });
      
      throw new Error(`Smart request handling failed: ${(error as Error).message}`);
    }
  }

  /**
   * Handle direct request (≤115K tokens)
   */
  private async handleDirectRequest(
    message: string,
    options: Required<Omit<SmartRequestOptions, 'sessionId' | 'chunkingOptions' | 'fileUploadOptions'>> 
      & Pick<SmartRequestOptions, 'sessionId' | 'chunkingOptions' | 'fileUploadOptions'>,
    steps: ProcessingStep[]
  ): Promise<SmartRequestResult> {
    const stepStart = Date.now();
    
    try {
      const createResponse = await createConversation(message);
      
      this.addProcessingStep(steps, 'Create Conversation', stepStart, Date.now() - stepStart, true, {
        conversationId: createResponse.conversation_id,
        requestId: createResponse.request_id
      });

      const answer = await this.pollForAnswer(
        createResponse.conversation_id,
        createResponse.request_id,
        options,
        steps
      );

      return {
        conversationId: createResponse.conversation_id,
        requestId: createResponse.request_id,
        strategy: 'direct',
        answer,
        totalInputTokens: 0, // Will be set by caller
        totalResponseTokens: smartEstimateTokens(answer),
        totalTime: 0, // Will be set by caller
        processingSteps: []
      };

    } catch (error) {
      this.addProcessingStep(steps, 'Direct Request', stepStart, Date.now() - stepStart, false, {
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Handle chunked request (115K-200K tokens)
   */
  private async handleChunkedRequest(
    message: string,
    options: Required<Omit<SmartRequestOptions, 'sessionId' | 'chunkingOptions' | 'fileUploadOptions' | 'progressCallback'>> 
      & Pick<SmartRequestOptions, 'sessionId' | 'chunkingOptions' | 'fileUploadOptions' | 'progressCallback'>,
    steps: ProcessingStep[]
  ): Promise<SmartRequestResult> {
    const stepStart = Date.now();
    
    try {
      // Create chunks
      const chunkOptions = options.chunkingOptions || calculateOptimalChunkSize(message);
      const chunks = chunkText(message, chunkOptions);
      
      this.addProcessingStep(steps, 'Text Chunking', stepStart, Date.now() - stepStart, true, {
        additionalInfo: `Created ${chunks.length} chunks`
      });

      if (chunks.length === 0) {
        throw new Error('No chunks generated from message');
      }

      let conversationId: string | undefined;
      let lastRequestId: string | undefined;
      let totalResponseTokens = 0;

      // Process each chunk
      for (const chunk of chunks) {
        const chunkStart = Date.now();
        let response;

        if (chunk.isFirst) {
          // First chunk creates the conversation
          const chunkMessage = this.formatChunkMessage(chunk, message);
          response = await createConversation(chunkMessage);
          conversationId = response.conversation_id;
        } else {
          // Subsequent chunks continue the conversation
          const chunkMessage = this.formatChunkMessage(chunk, message);
          response = await continueConversation(conversationId!, chunkMessage);
        }

        lastRequestId = response.request_id;

        this.addProcessingStep(steps, `Process Chunk ${chunk.index + 1}`, chunkStart, Date.now() - chunkStart, true, {
          tokens: chunk.tokens,
          conversationId: response.conversation_id,
          requestId: response.request_id
        });

        // Get answer for this chunk
        const chunkAnswer = await this.pollForAnswer(
          response.conversation_id,
          response.request_id,
          options,
          steps
        );

        totalResponseTokens += smartEstimateTokens(chunkAnswer);
      }

      // Get final consolidated answer
      const finalStart = Date.now();
      const finalRequest = await continueConversation(
        conversationId!,
        "Please provide a comprehensive summary and response based on all the information provided above."
      );

      const finalAnswer = await this.pollForAnswer(
        finalRequest.conversation_id,
        finalRequest.request_id,
        options,
        steps
      );

      totalResponseTokens += smartEstimateTokens(finalAnswer);

      this.addProcessingStep(steps, 'Final Consolidation', finalStart, Date.now() - finalStart, true, {
        tokens: smartEstimateTokens(finalAnswer)
      });

      return {
        conversationId: conversationId!,
        requestId: finalRequest.request_id,
        strategy: 'chunks',
        answer: finalAnswer,
        totalInputTokens: 0,
        totalResponseTokens,
        totalTime: 0,
        chunksProcessed: chunks.length,
        processingSteps: []
      };

    } catch (error) {
      this.addProcessingStep(steps, 'Chunked Request', stepStart, Date.now() - stepStart, false, {
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Handle file upload request (>200K tokens)
   */
  private async handleFileRequest(
    message: string,
    options: Required<Omit<SmartRequestOptions, 'sessionId' | 'chunkingOptions' | 'fileUploadOptions'>> 
      & Pick<SmartRequestOptions, 'sessionId' | 'chunkingOptions' | 'fileUploadOptions'>,
    steps: ProcessingStep[]
  ): Promise<SmartRequestResult> {
    const stepStart = Date.now();
    
    try {
      // Upload as file
      const uploadService = new FileUploadService(options.fileUploadOptions);
      const uploadResult = await uploadService.uploadTextAsFile(message);
      
      this.addProcessingStep(steps, 'File Upload', stepStart, Date.now() - stepStart, true, {
        tokens: uploadResult.tokens,
        additionalInfo: `File ID: ${uploadResult.fileId}`
      });

      // Create conversation with file reference
      const conversationStart = Date.now();
      const fileMessage = "Please analyze and respond to the content in the uploaded file.";
      const createResponse = await createConversation(fileMessage, [{ id: uploadResult.fileId }]);
      
      this.addProcessingStep(steps, 'Create Conversation with File', conversationStart, Date.now() - conversationStart, true, {
        conversationId: createResponse.conversation_id,
        requestId: createResponse.request_id
      });

      const answer = await this.pollForAnswer(
        createResponse.conversation_id,
        createResponse.request_id,
        options,
        steps,
        true // File processing may take longer
      );

      return {
        conversationId: createResponse.conversation_id,
        requestId: createResponse.request_id,
        strategy: 'file',
        answer,
        totalInputTokens: 0,
        totalResponseTokens: smartEstimateTokens(answer),
        totalTime: 0,
        fileId: uploadResult.fileId,
        processingSteps: []
      };

    } catch (error) {
      this.addProcessingStep(steps, 'File Request', stepStart, Date.now() - stepStart, false, {
        error: (error as Error).message
      });
      throw error;
    }
  }

  /**
   * Handle hybrid request (>500K tokens)
   */
  private async handleHybridRequest(
    message: string,
    options: Required<Omit<SmartRequestOptions, 'sessionId' | 'chunkingOptions' | 'fileUploadOptions'>> 
      & Pick<SmartRequestOptions, 'sessionId' | 'chunkingOptions' | 'fileUploadOptions'>,
    steps: ProcessingStep[]
  ): Promise<SmartRequestResult> {
    // Split message: first 200K tokens as file, rest as chunks
    const tokens = smartEstimateTokens(message);
    const splitPoint = Math.floor(message.length * (200000 / tokens));
    
    const fileContent = message.substring(0, splitPoint);
    const remainingContent = message.substring(splitPoint);

    // Upload file part
    const fileResult = await this.handleFileRequest(fileContent, options, steps);
    
    // Continue with remaining content as chunks
    if (remainingContent.trim()) {
      const chunkStart = Date.now();
      const continueMessage = `Additionally, please consider this information: ${remainingContent}`;
      
      const chunkOptions = options.chunkingOptions || calculateOptimalChunkSize(continueMessage);
      const chunks = chunkText(continueMessage, chunkOptions);
      
      for (const chunk of chunks) {
        const chunkMessage = this.formatChunkMessage(chunk, continueMessage);
        const response = await continueConversation(fileResult.conversationId, chunkMessage);
        
        await this.pollForAnswer(response.conversation_id, response.request_id, options, steps);
      }
      
      // Final consolidation
      const finalRequest = await continueConversation(
        fileResult.conversationId,
        "Please provide a comprehensive response considering both the uploaded file content and the additional information provided."
      );
      
      const finalAnswer = await this.pollForAnswer(
        finalRequest.conversation_id,
        finalRequest.request_id,
        options,
        steps
      );
      
      this.addProcessingStep(steps, 'Hybrid Processing', chunkStart, Date.now() - chunkStart, true, {
        additionalInfo: `File + ${chunks.length} chunks`
      });
      
      return {
        ...fileResult,
        strategy: 'hybrid',
        answer: finalAnswer,
        requestId: finalRequest.request_id,
        chunksProcessed: chunks.length
      };
    }
    
    return {
      ...fileResult,
      strategy: 'hybrid'
    };
  }

  /**
   * Poll for answer with adaptive timeout
   */
  private async pollForAnswer(
    conversationId: string,
    requestId: string,
    options: Required<Omit<SmartRequestOptions, 'sessionId' | 'chunkingOptions' | 'fileUploadOptions'>> 
      & Pick<SmartRequestOptions, 'sessionId' | 'chunkingOptions' | 'fileUploadOptions'>,
    steps: ProcessingStep[],
    isFileProcessing: boolean = false
  ): Promise<string> {
    const pollStart = Date.now();
    let attempts = 0;
    const maxAttempts = isFileProcessing ? options.maxPollAttempts * 2 : options.maxPollAttempts;
    
    while (attempts < maxAttempts) {
      try {
        const answerResponse = await getAnswer(conversationId, requestId);
        
        if (answerResponse.status === "finished" && answerResponse.answer) {
          this.addProcessingStep(steps, 'Poll for Answer', pollStart, Date.now() - pollStart, true, {
            additionalInfo: `Completed after ${attempts + 1} attempts`
          });
          return answerResponse.answer;
        }
        
        // Add delay between polling attempts
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
        
      } catch (error) {
        if (attempts >= maxAttempts - 1) {
          this.addProcessingStep(steps, 'Poll for Answer', pollStart, Date.now() - pollStart, false, {
            error: (error as Error).message,
            additionalInfo: `Failed after ${attempts + 1} attempts`
          });
          throw error;
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        attempts++;
      }
    }
    
    this.addProcessingStep(steps, 'Poll for Answer', pollStart, Date.now() - pollStart, false, {
      error: 'Timeout waiting for answer',
      additionalInfo: `Timed out after ${attempts} attempts`
    });
    
    throw new Error(`Timeout waiting for answer after ${attempts} attempts`);
  }

  /**
   * Format chunk message with context
   */
  private formatChunkMessage(chunk: any, originalMessage: string): string {
    if (chunk.isFirst && chunk.isLast) {
      return chunk.content;
    }
    
    let prefix = '';
    if (chunk.isFirst) {
      prefix = `[This is a large message split into ${chunk.totalChunks} parts. Part ${chunk.index + 1}/${chunk.totalChunks}]\n\n`;
    } else if (chunk.isLast) {
      prefix = `[Continuing from previous parts. Final part ${chunk.index + 1}/${chunk.totalChunks}]\n\n`;
    } else {
      prefix = `[Continuing from previous parts. Part ${chunk.index + 1}/${chunk.totalChunks}]\n\n`;
    }
    
    return prefix + chunk.content;
  }

  /**
   * Send progress update if callback is provided
   */
  private sendProgress(callback: ProgressCallback | undefined, update: ProgressUpdate): void {
    if (callback) {
      callback(update);
    }
  }

  /**
   * Add processing step to tracking
   */
  private addProcessingStep(
    steps: ProcessingStep[],
    step: string,
    startTime: number,
    duration: number,
    success: boolean,
    extra: any = {}
  ): void {
    steps.push({
      step,
      startTime,
      duration,
      success,
      tokens: extra.tokens,
      error: extra.error,
      conversationId: extra.conversationId,
      requestId: extra.requestId,
      ...extra
    });
  }
}

/**
 * Convenience function for handling large requests
 */
export async function handleLargeRequest(
  message: string,
  options: SmartRequestOptions = {}
): Promise<SmartRequestResult> {
  const handler = new SmartRequestHandler(options);
  return handler.handleLargeRequest(message, options);
}