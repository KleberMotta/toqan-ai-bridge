/**
 * File Upload Service for Toqan AI Bridge
 * 
 * Handles file uploads for large contexts that exceed chunking thresholds.
 * Provides automatic cleanup and retry logic.
 */

import { uploadFile as toqanUploadFile } from './toqanClient';
import { smartEstimateTokens } from './utils/tokenEstimation';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface FileUploadOptions {
  /** Filename to use for the upload */
  filename?: string;
  /** Content type for the file */
  contentType?: string;
  /** Auto cleanup temp file after upload */
  autoCleanup?: boolean;
  /** Directory for temporary files */
  tempDir?: string;
  /** Maximum retries for upload */
  maxRetries?: number;
}

export interface FileUploadResult {
  /** File ID returned by Toqan API */
  fileId: string;
  /** Original text content */
  content: string;
  /** Estimated tokens in the content */
  tokens: number;
  /** Temporary file path (if created) */
  tempFilePath?: string;
  /** File size in bytes */
  fileSize: number;
  /** Upload duration in milliseconds */
  uploadDuration: number;
}

/**
 * File upload service class
 */
export class FileUploadService {
  private options: Required<FileUploadOptions>;
  private uploadedFiles: Map<string, FileUploadResult> = new Map();

  constructor(options: FileUploadOptions = {}) {
    this.options = {
      filename: options.filename ?? 'context.txt',
      contentType: options.contentType ?? 'text/plain',
      autoCleanup: options.autoCleanup ?? true,
      tempDir: options.tempDir ?? process.cwd(),
      maxRetries: options.maxRetries ?? 3
    };
  }

  /**
   * Upload text content as a file to Toqan
   */
  public async uploadTextAsFile(
    content: string, 
    options: Partial<FileUploadOptions> = {}
  ): Promise<FileUploadResult> {
    const mergedOptions = { ...this.options, ...options };
    
    if (!content || content.trim().length === 0) {
      throw new Error('Content cannot be empty for file upload');
    }

    const tokens = smartEstimateTokens(content);
    let tempFilePath: string | undefined;
    
    try {
      // Create temporary file
      const filename = this.generateFilename(mergedOptions.filename!);
      tempFilePath = path.join(mergedOptions.tempDir!, filename);
      
      fs.writeFileSync(tempFilePath, content, 'utf8');
      const fileSize = fs.statSync(tempFilePath).size;
      
      // Upload with retry logic
      const startTime = Date.now();
      const fileId = await this.uploadWithRetry(
        tempFilePath, 
        filename, 
        mergedOptions.contentType!,
        mergedOptions.maxRetries!
      );
      const uploadDuration = Date.now() - startTime;
      
      const result: FileUploadResult = {
        fileId,
        content,
        tokens,
        tempFilePath: mergedOptions.autoCleanup ? undefined : tempFilePath,
        fileSize,
        uploadDuration
      };
      
      // Store for tracking
      this.uploadedFiles.set(fileId, result);
      
      // Auto cleanup if enabled
      if (mergedOptions.autoCleanup && tempFilePath) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (cleanupError) {
          console.warn(`Failed to cleanup temp file ${tempFilePath}:`, cleanupError);
        }
      }
      
      return result;
      
    } catch (error) {
      // Cleanup temp file on error
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (cleanupError) {
          console.warn(`Failed to cleanup temp file after error:`, cleanupError);
        }
      }
      
      throw new Error(`File upload failed: ${(error as Error).message}`);
    }
  }

  /**
   * Upload existing file to Toqan
   */
  public async uploadExistingFile(
    filePath: string,
    options: Partial<FileUploadOptions> = {}
  ): Promise<FileUploadResult> {
    const mergedOptions = { ...this.options, ...options };
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const tokens = smartEstimateTokens(content);
      const fileSize = fs.statSync(filePath).size;
      const filename = mergedOptions.filename ?? path.basename(filePath);
      
      const startTime = Date.now();
      const fileId = await this.uploadWithRetry(
        filePath,
        filename,
        mergedOptions.contentType!,
        mergedOptions.maxRetries!
      );
      const uploadDuration = Date.now() - startTime;
      
      const result: FileUploadResult = {
        fileId,
        content,
        tokens,
        fileSize,
        uploadDuration
      };
      
      this.uploadedFiles.set(fileId, result);
      return result;
      
    } catch (error) {
      throw new Error(`File upload failed: ${(error as Error).message}`);
    }
  }

  /**
   * Get info about uploaded file
   */
  public getUploadInfo(fileId: string): FileUploadResult | undefined {
    return this.uploadedFiles.get(fileId);
  }

  /**
   * Cleanup all tracked temporary files
   */
  public cleanupTempFiles(): void {
    for (const [fileId, result] of this.uploadedFiles.entries()) {
      if (result.tempFilePath && fs.existsSync(result.tempFilePath)) {
        try {
          fs.unlinkSync(result.tempFilePath);
          // Remove temp path from result
          result.tempFilePath = undefined;
        } catch (error) {
          console.warn(`Failed to cleanup temp file for ${fileId}:`, error);
        }
      }
    }
  }

  /**
   * Check if content should be uploaded as file based on size/strategy
   */
  public static shouldUseFileUpload(content: string, strategy?: 'direct' | 'chunks' | 'file' | 'hybrid'): boolean {
    if (strategy) {
      return strategy === 'file' || strategy === 'hybrid';
    }
    
    const tokens = smartEstimateTokens(content);
    return tokens > 200000; // Above 200K tokens, use file upload
  }

  /**
   * Upload with retry logic
   */
  private async uploadWithRetry(
    filePath: string, 
    filename: string, 
    contentType: string,
    maxRetries: number
  ): Promise<string> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const fileBuffer = fs.readFileSync(filePath);
        const response = await toqanUploadFile(fileBuffer, filename, contentType);
        return response.file_id;
        
      } catch (error) {
        lastError = error as Error;
        
        if (attempt < maxRetries) {
          // Exponential backoff
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          await new Promise(resolve => setTimeout(resolve, delay));
          console.warn(`Upload attempt ${attempt} failed, retrying in ${delay}ms:`, error);
        }
      }
    }
    
    throw new Error(`Upload failed after ${maxRetries} attempts: ${lastError?.message}`);
  }

  /**
   * Generate unique filename
   */
  private generateFilename(baseFilename: string): string {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    const ext = path.extname(baseFilename) || '.txt';
    const base = path.basename(baseFilename, ext);
    
    return `${base}-${timestamp}-${random}${ext}`;
  }
}

/**
 * Convenience function for quick file uploads
 */
export async function uploadTextAsFile(
  content: string,
  options: FileUploadOptions = {}
): Promise<FileUploadResult> {
  const service = new FileUploadService(options);
  return service.uploadTextAsFile(content, options);
}

/**
 * Check if file upload is recommended for given content
 */
export function shouldUseFileUpload(content: string): boolean {
  return FileUploadService.shouldUseFileUpload(content);
}

/**
 * Estimate file upload time based on content size
 */
export function estimateUploadTime(content: string): number {
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const sizeMB = sizeBytes / (1024 * 1024);
  
  // Rough estimation: 1MB per 2 seconds for upload + processing
  return Math.max(2000, sizeMB * 2000);
}