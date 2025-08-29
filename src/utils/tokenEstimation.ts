/**
 * Token estimation utilities for Toqan AI Bridge
 * 
 * Based on empirical testing, provides improved token estimation
 * compared to the simple 1 token ≈ 4 chars approximation.
 */

export interface TokenEstimationOptions {
  /** Content type affects token density */
  contentType?: 'natural_language' | 'code' | 'structured_data' | 'mixed';
  /** Language affects tokenization (English is baseline) */
  language?: 'english' | 'portuguese' | 'mixed' | 'other';
}

/**
 * Improved token estimation based on content analysis
 */
export function estimateTokens(text: string, options: TokenEstimationOptions = {}): number {
  if (!text || text.length === 0) {
    return 0;
  }

  const { contentType = 'mixed', language = 'mixed' } = options;
  
  // Base estimation: 1 token ≈ 4 characters (empirically validated)
  let baseTokens = Math.ceil(text.length / 4);
  
  // Adjust based on content type
  let contentMultiplier = 1.0;
  switch (contentType) {
    case 'natural_language':
      contentMultiplier = 0.85; // Natural language is more token-efficient
      break;
    case 'code':
      contentMultiplier = 1.15; // Code has more symbols and special chars
      break;
    case 'structured_data':
      contentMultiplier = 1.1; // JSON, XML etc have overhead
      break;
    case 'mixed':
    default:
      contentMultiplier = 1.0; // Use base estimation
      break;
  }
  
  // Adjust based on language
  let languageMultiplier = 1.0;
  switch (language) {
    case 'english':
      languageMultiplier = 0.95; // English is baseline, slightly more efficient
      break;
    case 'portuguese':
      languageMultiplier = 1.05; // Portuguese tends to be more verbose
      break;
    case 'mixed':
    case 'other':
    default:
      languageMultiplier = 1.0;
      break;
  }
  
  // Additional adjustments based on text characteristics
  let characteristicMultiplier = 1.0;
  
  // Repetitive text is more efficient
  const repetitiveness = calculateRepetitiveness(text);
  if (repetitiveness > 0.3) {
    characteristicMultiplier *= 0.9;
  }
  
  // Lots of whitespace is less efficient
  const whitespaceRatio = (text.match(/\s/g) || []).length / text.length;
  if (whitespaceRatio > 0.25) {
    characteristicMultiplier *= 1.05;
  }
  
  const estimatedTokens = Math.ceil(
    baseTokens * contentMultiplier * languageMultiplier * characteristicMultiplier
  );
  
  return Math.max(1, estimatedTokens); // Minimum 1 token
}

/**
 * Calculate text repetitiveness (0 = no repetition, 1 = completely repetitive)
 */
function calculateRepetitiveness(text: string): number {
  if (text.length < 100) {
    return 0; // Too short to determine repetitiveness
  }
  
  // Sample approach: look for repeated patterns
  const words = text.toLowerCase().split(/\s+/);
  if (words.length < 10) {
    return 0;
  }
  
  // Count unique vs total words
  const uniqueWords = new Set(words);
  const repetitiveness = 1 - (uniqueWords.size / words.length);
  
  return Math.min(1, Math.max(0, repetitiveness));
}

/**
 * Estimate tokens for different content types automatically
 */
export function smartEstimateTokens(text: string): number {
  const contentType = detectContentType(text);
  const language = detectLanguage(text);
  
  return estimateTokens(text, { contentType, language });
}

/**
 * Detect content type from text analysis
 */
function detectContentType(text: string): TokenEstimationOptions['contentType'] {
  // Code patterns
  const codePatterns = [
    /function\s+\w+\s*\(/,
    /class\s+\w+/,
    /import\s+.*from/,
    /\{[\s\S]*\}/,
    /\/\*[\s\S]*?\*\//,
    /\/\/.*$/m
  ];
  
  const codeScore = codePatterns.reduce((score, pattern) => {
    return score + (pattern.test(text) ? 1 : 0);
  }, 0);
  
  // Structured data patterns  
  const structuredPatterns = [
    /^\s*[\{\[]/,
    /"\w+":\s*["\d\[\{]/,
    /<\/?\w+[^>]*>/,
    /^\s*\w+:\s*.+$/m
  ];
  
  const structuredScore = structuredPatterns.reduce((score, pattern) => {
    return score + (pattern.test(text) ? 1 : 0);
  }, 0);
  
  if (codeScore >= 2) {
    return 'code';
  } else if (structuredScore >= 2) {
    return 'structured_data';
  } else if (text.match(/^[A-Za-z\s.,!?;:'"()-]+$/)) {
    return 'natural_language';
  } else {
    return 'mixed';
  }
}

/**
 * Detect language from text analysis
 */
function detectLanguage(text: string): TokenEstimationOptions['language'] {
  // Simple heuristics for Portuguese vs English
  const portugueseWords = [
    'que', 'não', 'para', 'com', 'uma', 'mais', 'muito', 'quando', 'onde', 'como',
    'também', 'então', 'porque', 'sobre', 'depois', 'apenas', 'assim', 'ainda'
  ];
  
  const englishWords = [
    'the', 'and', 'that', 'with', 'for', 'you', 'this', 'but', 'his', 'from',
    'they', 'she', 'her', 'been', 'than', 'what', 'were', 'said', 'each', 'which'
  ];
  
  const words = text.toLowerCase().split(/\s+/).slice(0, 100); // Sample first 100 words
  
  const portugueseScore = words.filter(word => portugueseWords.includes(word)).length;
  const englishScore = words.filter(word => englishWords.includes(word)).length;
  
  if (portugueseScore > englishScore && portugueseScore > 2) {
    return 'portuguese';
  } else if (englishScore > portugueseScore && englishScore > 2) {
    return 'english';
  } else {
    return 'mixed';
  }
}

/**
 * Check if text size exceeds token limit
 */
export function exceedsTokenLimit(text: string, limit: number = 120000): boolean {
  return smartEstimateTokens(text) > limit;
}

/**
 * Get recommended chunking strategy based on text size
 */
export function getRecommendedStrategy(text: string): 'direct' | 'chunks' | 'file' | 'hybrid' {
  const tokens = smartEstimateTokens(text);
  
  if (tokens <= 115000) { // 115K with safety margin
    return 'direct';
  } else if (tokens <= 200000) { // 200K tokens
    return 'chunks';
  } else if (tokens <= 500000) { // 500K tokens
    return 'file';
  } else {
    return 'hybrid'; // File + chunks
  }
}