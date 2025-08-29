/**
 * Chunking Service for Toqan AI Bridge
 * 
 * Handles intelligent splitting of large messages into smaller chunks
 * that respect the 120K token limit while preserving semantic meaning.
 */

import { smartEstimateTokens, estimateTokens } from './utils/tokenEstimation';

export interface ChunkOptions {
  /** Maximum tokens per chunk (default: 115000 for safety margin) */
  maxTokensPerChunk?: number;
  /** Overlap between chunks in tokens for context preservation */
  overlapTokens?: number;
  /** Strategy for splitting text */
  splitStrategy?: 'paragraph' | 'sentence' | 'word' | 'character';
  /** Prefix/suffix to add to chunks for context */
  chunkPrefix?: string;
  chunkSuffix?: string;
}

export interface TextChunk {
  /** Chunk content */
  content: string;
  /** Estimated tokens in this chunk */
  tokens: number;
  /** Chunk index (0-based) */
  index: number;
  /** Total number of chunks */
  totalChunks: number;
  /** Is this the first chunk? */
  isFirst: boolean;
  /** Is this the last chunk? */
  isLast: boolean;
  /** Character start position in original text */
  startPos: number;
  /** Character end position in original text */
  endPos: number;
}

/**
 * Main chunking service class
 */
export class ChunkingService {
  private options: Required<ChunkOptions>;

  constructor(options: ChunkOptions = {}) {
    this.options = {
      maxTokensPerChunk: options.maxTokensPerChunk ?? 115000,
      overlapTokens: options.overlapTokens ?? 1000,
      splitStrategy: options.splitStrategy ?? 'paragraph',
      chunkPrefix: options.chunkPrefix ?? '',
      chunkSuffix: options.chunkSuffix ?? ''
    };
  }

  /**
   * Split text into chunks based on token limits
   */
  public splitText(text: string): TextChunk[] {
    if (!text || text.trim().length === 0) {
      return [];
    }

    const totalTokens = smartEstimateTokens(text);
    
    // If text fits in one chunk, return as-is
    if (totalTokens <= this.options.maxTokensPerChunk) {
      return [{
        content: text,
        tokens: totalTokens,
        index: 0,
        totalChunks: 1,
        isFirst: true,
        isLast: true,
        startPos: 0,
        endPos: text.length
      }];
    }

    // Split using the configured strategy
    const chunks = this.performSplit(text);
    
    // Add metadata to chunks
    return chunks.map((chunk, index) => ({
      ...chunk,
      index,
      totalChunks: chunks.length,
      isFirst: index === 0,
      isLast: index === chunks.length - 1
    }));
  }

  /**
   * Perform the actual splitting based on strategy
   */
  private performSplit(text: string): Omit<TextChunk, 'index' | 'totalChunks' | 'isFirst' | 'isLast'>[] {
    switch (this.options.splitStrategy) {
      case 'paragraph':
        return this.splitByParagraphs(text);
      case 'sentence':
        return this.splitBySentences(text);
      case 'word':
        return this.splitByWords(text);
      case 'character':
      default:
        return this.splitByCharacters(text);
    }
  }

  /**
   * Split by paragraphs (most semantic preservation)
   */
  private splitByParagraphs(text: string): Omit<TextChunk, 'index' | 'totalChunks' | 'isFirst' | 'isLast'>[] {
    const paragraphs = text.split(/\n\s*\n/);
    return this.groupIntoBuckets(paragraphs, '\n\n');
  }

  /**
   * Split by sentences (good semantic preservation)
   */
  private splitBySentences(text: string): Omit<TextChunk, 'index' | 'totalChunks' | 'isFirst' | 'isLast'>[] {
    // Enhanced sentence splitting that handles abbreviations better
    const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/);
    return this.groupIntoBuckets(sentences, ' ');
  }

  /**
   * Split by words (moderate semantic preservation)
   */
  private splitByWords(text: string): Omit<TextChunk, 'index' | 'totalChunks' | 'isFirst' | 'isLast'>[] {
    const words = text.split(/\s+/);
    return this.groupIntoBuckets(words, ' ');
  }

  /**
   * Split by characters (last resort, minimal semantic preservation)
   */
  private splitByCharacters(text: string): Omit<TextChunk, 'index' | 'totalChunks' | 'isFirst' | 'isLast'>[] {
    const chunks: Omit<TextChunk, 'index' | 'totalChunks' | 'isFirst' | 'isLast'>[] = [];
    const maxCharsPerChunk = this.options.maxTokensPerChunk * 4; // Rough approximation
    
    let startPos = 0;
    while (startPos < text.length) {
      let endPos = Math.min(startPos + maxCharsPerChunk, text.length);
      
      // Try to break at a more natural boundary
      if (endPos < text.length) {
        const nearbySpace = text.lastIndexOf(' ', endPos);
        if (nearbySpace > startPos && nearbySpace > endPos - 100) {
          endPos = nearbySpace;
        }
      }
      
      const chunkContent = text.slice(startPos, endPos);
      chunks.push({
        content: this.addPrefixSuffix(chunkContent),
        tokens: smartEstimateTokens(chunkContent),
        startPos,
        endPos
      });
      
      startPos = endPos;
    }
    
    return chunks;
  }

  /**
   * Group text units (paragraphs, sentences, words) into token-sized buckets
   */
  private groupIntoBuckets(
    units: string[], 
    separator: string
  ): Omit<TextChunk, 'index' | 'totalChunks' | 'isFirst' | 'isLast'>[] {
    const chunks: Omit<TextChunk, 'index' | 'totalChunks' | 'isFirst' | 'isLast'>[] = [];
    let currentChunk: string[] = [];
    let currentTokens = 0;
    let startPos = 0;
    let currentPos = 0;

    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const unitTokens = smartEstimateTokens(unit);
      const separatorTokens = i > 0 ? smartEstimateTokens(separator) : 0;
      
      // Check if adding this unit would exceed the limit
      const totalTokensWithUnit = currentTokens + unitTokens + separatorTokens;
      
      if (totalTokensWithUnit > this.options.maxTokensPerChunk && currentChunk.length > 0) {
        // Finalize current chunk
        const chunkContent = currentChunk.join(separator);
        chunks.push({
          content: this.addPrefixSuffix(chunkContent),
          tokens: currentTokens,
          startPos,
          endPos: currentPos
        });
        
        // Start new chunk with overlap if configured
        startPos = currentPos;
        currentChunk = [];
        currentTokens = 0;
        
        // Add overlap from previous chunk if configured
        if (this.options.overlapTokens > 0 && chunks.length > 0) {
          const overlapContent = this.extractOverlap(chunkContent, this.options.overlapTokens);
          if (overlapContent) {
            currentChunk.push(overlapContent);
            currentTokens += smartEstimateTokens(overlapContent);
          }
        }
      }
      
      // Add current unit to chunk
      currentChunk.push(unit);
      currentTokens += unitTokens + separatorTokens;
      currentPos += unit.length + (i > 0 ? separator.length : 0);
    }
    
    // Add remaining chunk
    if (currentChunk.length > 0) {
      chunks.push({
        content: this.addPrefixSuffix(currentChunk.join(separator)),
        tokens: currentTokens,
        startPos,
        endPos: currentPos
      });
    }
    
    return chunks;
  }

  /**
   * Extract overlap content from end of text
   */
  private extractOverlap(text: string, overlapTokens: number): string | null {
    const words = text.split(/\s+/);
    const wordsToTake = Math.min(Math.floor(overlapTokens / 2), words.length);
    
    if (wordsToTake === 0) return null;
    
    return '...' + words.slice(-wordsToTake).join(' ');
  }

  /**
   * Add prefix and suffix to chunk content
   */
  private addPrefixSuffix(content: string): string {
    return this.options.chunkPrefix + content + this.options.chunkSuffix;
  }
}

/**
 * Convenience function to split text with default options
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const service = new ChunkingService(options);
  return service.splitText(text);
}

/**
 * Calculate optimal chunk size based on text characteristics
 */
export function calculateOptimalChunkSize(text: string): ChunkOptions {
  const totalTokens = smartEstimateTokens(text);
  
  // For small texts, use direct sending
  if (totalTokens <= 115000) {
    return {
      maxTokensPerChunk: totalTokens,
      splitStrategy: 'paragraph'
    };
  }
  
  // Determine strategy based on text structure
  const paragraphs = text.split(/\n\s*\n/).length;
  const sentences = text.split(/[.!?]+/).length;
  
  let splitStrategy: ChunkOptions['splitStrategy'];
  if (paragraphs > 10) {
    splitStrategy = 'paragraph';
  } else if (sentences > 50) {
    splitStrategy = 'sentence';
  } else {
    splitStrategy = 'word';
  }
  
  // Calculate overlap based on content type
  const overlapTokens = Math.min(2000, Math.floor(totalTokens * 0.02)); // 2% overlap, max 2K tokens
  
  return {
    maxTokensPerChunk: 115000,
    overlapTokens,
    splitStrategy,
    chunkPrefix: '',
    chunkSuffix: ''
  };
}