/**
 * Progress Stream Manager for Toqan AI Bridge
 * 
 * Provides centralized progress reporting via SSE streams
 * for long-running operations like chunking and file uploads
 */

import { FastifyReply } from 'fastify';

export interface ProgressUpdate {
  type: 'progress' | 'status' | 'error' | 'complete';
  message: string;
  step?: string;
  current?: number;
  total?: number;
  timestamp?: number;
  additionalData?: any;
}

export interface ProgressStreamOptions {
  /** Minimum interval between progress updates in ms */
  updateInterval?: number;
  /** Buffer size for progress messages */
  bufferSize?: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Manages progress reporting for streaming responses
 */
export class ProgressStreamManager {
  private reply: FastifyReply['raw'];
  private lastUpdateTime: number = 0;
  private messageBuffer: ProgressUpdate[] = [];
  private options: Required<ProgressStreamOptions>;
  private closed: boolean = false;

  constructor(reply: FastifyReply['raw'], options: ProgressStreamOptions = {}) {
    this.reply = reply;
    this.options = {
      updateInterval: options.updateInterval ?? 1000, // 1 second default
      bufferSize: options.bufferSize ?? 10,
      debug: options.debug ?? false
    };
  }

  /**
   * Send a progress update to the client
   */
  public sendProgress(update: ProgressUpdate): void {
    if (this.closed) return;

    const now = Date.now();
    const fullUpdate: ProgressUpdate = {
      ...update,
      timestamp: now
    };

    // Add to buffer
    this.messageBuffer.push(fullUpdate);

    // Check if we should send based on interval or buffer size
    const shouldSend = 
      now - this.lastUpdateTime >= this.options.updateInterval ||
      this.messageBuffer.length >= this.options.bufferSize ||
      update.type === 'error' ||
      update.type === 'complete';

    if (shouldSend) {
      this.flushBuffer();
    }
  }

  /**
   * Send chunking progress update
   */
  public sendChunkingProgress(current: number, total: number, message?: string): void {
    this.sendProgress({
      type: 'progress',
      message: message || `Processando chunk ${current}/${total}...`,
      step: 'chunking',
      current,
      total
    });
  }

  /**
   * Send file upload progress update
   */
  public sendFileUploadProgress(message: string, additionalData?: any): void {
    this.sendProgress({
      type: 'progress',
      message,
      step: 'file_upload',
      additionalData
    });
  }

  /**
   * Send status update
   */
  public sendStatus(message: string, step?: string): void {
    this.sendProgress({
      type: 'status',
      message,
      step
    });
  }

  /**
   * Send error update
   */
  public sendError(message: string, error?: any): void {
    this.sendProgress({
      type: 'error',
      message,
      additionalData: error
    });
  }

  /**
   * Send completion update
   */
  public sendComplete(message: string = 'Processamento concluído'): void {
    this.sendProgress({
      type: 'complete',
      message
    });
    this.flushBuffer();
  }

  /**
   * Send delta text content (actual streaming content)
   */
  public sendDelta(text: string): void {
    if (this.closed) return;

    try {
      this.reply.write(`data: ${JSON.stringify({ delta: text })}\n\n`);
    } catch (error) {
      if (this.options.debug) {
        console.error('Failed to send delta:', error);
      }
      this.closed = true;
    }
  }

  /**
   * Send done signal to complete the stream
   */
  public sendDone(): void {
    if (this.closed) return;

    try {
      this.reply.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      this.closed = true;
    } catch (error) {
      if (this.options.debug) {
        console.error('Failed to send done signal:', error);
      }
    }
  }

  /**
   * Flush buffered messages to the stream
   */
  private flushBuffer(): void {
    if (this.closed || this.messageBuffer.length === 0) return;

    try {
      // Send all buffered messages
      for (const update of this.messageBuffer) {
        const progressData = {
          progress: update,
          delta: `[${update.message}]\n`
        };
        
        this.reply.write(`data: ${JSON.stringify(progressData)}\n\n`);

        if (this.options.debug) {
          console.log('Progress sent:', update);
        }
      }

      this.messageBuffer = [];
      this.lastUpdateTime = Date.now();

    } catch (error) {
      if (this.options.debug) {
        console.error('Failed to flush buffer:', error);
      }
      this.closed = true;
    }
  }

  /**
   * Check if the stream is closed
   */
  public isClosed(): boolean {
    return this.closed;
  }

  /**
   * Close the stream and clean up
   */
  public close(): void {
    if (!this.closed) {
      this.flushBuffer();
      this.closed = true;
    }
  }
}

/**
 * Progress callback function type for use in other services
 */
export type ProgressCallback = (update: ProgressUpdate) => void;

/**
 * Create a progress callback that sends updates to a stream manager
 */
export function createProgressCallback(streamManager: ProgressStreamManager): ProgressCallback {
  return (update: ProgressUpdate) => {
    streamManager.sendProgress(update);
  };
}

/**
 * Utility function to create chunking progress updates
 */
export function createChunkingProgressCallback(
  streamManager: ProgressStreamManager,
  totalChunks: number
): (currentChunk: number, message?: string) => void {
  return (currentChunk: number, message?: string) => {
    streamManager.sendChunkingProgress(currentChunk, totalChunks, message);
  };
}

/**
 * Utility function to create file upload progress updates
 */
export function createFileUploadProgressCallback(
  streamManager: ProgressStreamManager
): (message: string, data?: any) => void {
  return (message: string, data?: any) => {
    streamManager.sendFileUploadProgress(message, data);
  };
}