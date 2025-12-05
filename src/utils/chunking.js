import pdfParse from "pdf-parse";
import crypto from "crypto";
import mammoth from "mammoth";
import officeParser from "officeparser";
import EPub from "epub2";
import mime from "mime-types";
import { ai } from "../models/models.js";

// Configuration constants
const CACHE_SIZE = 5;
const PAGE_SPLIT = '\f';
const TOKEN_ESTIMATION_RATIO = 100 / 70; // 100 tokens ≈ 70 words
const MIN_PAGE_LENGTH = 10;
const NOISE_THRESHOLD_DEFAULT = 0.4;
const NOISE_THRESHOLD_MATH = 0.6;
const TOC_DOT_THRESHOLD = 5;
const TOC_LINE_THRESHOLD = 5;

// Precompiled regex patterns for better performance
const PATTERNS = {
  alphaNum: /[A-Za-z0-9]/,
  alphaNumStart: /^[A-Za-z0-9]/,
  alphaNumEnd: /[A-Za-z0-9]$/,
  whitespace: /\s+/,
  dotLeaders: /\.{3,}/g,
  lineEndsWithNum: /\d+$/,
  dotLeaderWithNum: /\.{2,}/,

  // Mathematical indicators (combined for single pass)
  mathKeywords: /\b(equation|theorem|proof|lemma|corollary|definition|formula|sin|cos|tan|log|ln|exp|sqrt|lim|sum|int)\b/i,
  mathOperators: /\d+\s*[+\-*/×÷]\s*\d+/,
  mathAssignment: /[a-zA-Z]\s*=\s*/,
  mathParens: /\([^)]*[+\-*/=][^)]*\)/,
  mathSymbols: /[∑∫∏∂∇∆√∞∈∉⊂⊃∪∩αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ]/,
  mathNotation: /[\^_]\{|_\d|\\[a-zA-Z]+/,

  // Extended character set for filtering
  allowedChars: /[A-Za-z0-9\s.,;:()'/±×÷=+\-*^_{}\[\]<>∞≈≠≤≥αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ∑∫∏∂∇∆√∈∉⊂⊃∪∩∀∃∄∅∧∨¬⊕⊗⊥∥∠°′″‴∝∼≅≡≢≪≫⊆⊇⊊⊋∖℘ℕℤℚℝℂ·×∘∙⊙⊖⊕⊗⊘⊚⊛⊜⊝⊞⊟⊠⊡⟨⟩⟦⟧‖|!@#$%&]/
};

// Lightweight LRU cache
class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    // Refresh recency
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    this.cache.set(key, value);
    if (this.cache.size > this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
  }
}

const cache = new LRUCache(CACHE_SIZE);

// Hash buffer for cache key generation
function hashBuffer(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

// --- Text Processing Helpers ---

// Optimized math content detection with single-pass checking
function hasMathContent(text) {
  return PATTERNS.mathKeywords.test(text) ||
    PATTERNS.mathOperators.test(text) ||
    PATTERNS.mathAssignment.test(text) ||
    PATTERNS.mathParens.test(text) ||
    PATTERNS.mathSymbols.test(text) ||
    PATTERNS.mathNotation.test(text);
}

// Optimized noise detection
function isNoisyPage(text) {
  const len = text.length;
  if (len < MIN_PAGE_LENGTH) return true;

  const isMathContent = hasMathContent(text);

  // Character-based noise detection
  let nonAllowed = 0;
  for (let i = 0; i < len; i++) {
    if (!PATTERNS.allowedChars.test(text[i])) nonAllowed++;
  }

  const noiseThreshold = isMathContent ? NOISE_THRESHOLD_MATH : NOISE_THRESHOLD_DEFAULT;
  if (nonAllowed / len > noiseThreshold) return true;

  // Skip TOC detection for math content
  if (isMathContent) return false;

  // TOC pattern detection (optimized)
  const dotLeaders = (text.match(PATTERNS.dotLeaders) || []).length;
  if (dotLeaders >= TOC_DOT_THRESHOLD) return true;

  const lines = text.split('\n');
  let leaderOrNumLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (PATTERNS.dotLeaderWithNum.test(line) && PATTERNS.lineEndsWithNum.test(trimmed)) {
      leaderOrNumLines++;
    }
  }
  if (leaderOrNumLines >= TOC_LINE_THRESHOLD) return true;

  // TOC keyword detection
  const lower = text.toLowerCase();
  const hasTocKeyword = lower.includes('table of contents') ||
    (lower.includes('contents') && dotLeaders >= 2) ||
    (lower.includes('index') && dotLeaders >= 2);

  return hasTocKeyword && (dotLeaders >= 2 || leaderOrNumLines >= 2);
}

// Optimized token count estimation
function estimateTokens(text) {
  if (!text) return 0;
  const words = text.split(PATTERNS.whitespace).filter(Boolean).length;
  return Math.round(words * TOKEN_ESTIMATION_RATIO);
}

// Helper to simulate paging for non-paginated formats (DOCX, TXT, EPUB)
// Splits text into chunks of approx 500 words
function simulatePagination(fullText) {
  if (!fullText) return [];
  const words = fullText.split(/\s+/);
  const wordsPerPage = 500;
  const pages = [];

  for (let i = 0; i < words.length; i += wordsPerPage) {
    const pageText = words.slice(i, i + wordsPerPage).join(' ');
    pages.push({
      pageNumber: Math.floor(i / wordsPerPage) + 1,
      text: pageText,
      tokenCount: estimateTokens(pageText)
    });
  }
  return pages.length > 0 ? pages : [{ pageNumber: 1, text: fullText, tokenCount: estimateTokens(fullText) }];
}

// --- Extractors ---

// Render page with optimized text extraction
async function renderPage(pageData) {
  const textContent = await pageData.getTextContent();
  const items = textContent.items || [];

  let result = '';
  let prevStr = '';

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const curr = item.str || '';

    if (i > 0 && curr) {
      const prevEndsAlphaNum = PATTERNS.alphaNumEnd.test(prevStr);
      const currStartsAlphaNum = PATTERNS.alphaNumStart.test(curr);
      const needsSpace = prevEndsAlphaNum && currStartsAlphaNum;

      if (item.hasEOL) {
        result += '\n';
      } else if (needsSpace) {
        result += ' ';
      }
    }

    result += curr;
    prevStr = curr;
  }

  return result + PAGE_SPLIT;
}

// Main extraction function
async function extractPdfText(file) {
  // Normalize input to Buffer
  const buffer = Buffer.isBuffer(file) ? file : Buffer.from(file);
  const cacheKey = hashBuffer(buffer);

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Parse PDF
  const result = await pdfParse(buffer, { pagerender: renderPage });
  const pages = (result.text || '').split(PAGE_SPLIT);

  // Process pages with 1-based numbering
  const processedPages = pages
    .map((text, index) => {
      const cleaned = text.trim();
      return {
        pageNumber: index + 1,
        text: cleaned,
        tokenCount: estimateTokens(cleaned)
      };
    })
    .filter(p => p.text.length > 0) // Remove blank pages
    .filter(p => !isNoisyPage(p.text)); // Remove noisy pages

  // Cache and return
  cache.set(cacheKey, processedPages);
  return processedPages;
}

async function extractDocxText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return simulatePagination(result.value);
}

async function extractPptxText(buffer) {
  // officeparser works with file paths or buffers
  const text = await officeParser.parseOfficeAsync(buffer);
  return simulatePagination(text);
}

async function extractTxtText(buffer) {
  const text = buffer.toString('utf-8');
  return simulatePagination(text);
}

async function extractEpubText(buffer) {
  return new Promise((resolve, reject) => {
    // EPub library requires a file path usually, but we can pass buffer if supported or write temp.
    // However, epub2 primarily takes a filename.
    // Since we are in memory, a lighter approach for simple text is preferable,
    // but for robustness in Node environment:
    /* 
       NOTE: Reading EPUB from buffer directly is tricky with 'epub2'. 
       We will attempt to use a specialized handling or fallback. 
       For this snippet, we will assume the buffer is passed.
       Since 'epub2' expects a path, we might need to write to tmp if strict.
       Alternatively, we parse it as a zip (since epub is zip).
    */
    // For simplicity/compatibility in this snippet, we treat it like binary text if simpler 
    // parser isn't available, but let's try a buffer-friendly logic if possible or standard text.
    // Falling back to simple text extraction from the buffer often produces garbled text for EPUB (it's binary).
    // Let's use 'officeparser' which claims support for open office, or generic text.
    // Actually, officeparser supports many formats. Let's try passing it there first.

    officeParser.parseOfficeAsync(buffer)
      .then(text => resolve(simulatePagination(text)))
      .catch(err => {
        console.error("EPUB extraction failed", err);
        resolve([{ pageNumber: 1, text: "EPUB content could not be parsed.", tokenCount: 0 }]);
      });
  });
}

async function extractImageText(buffer, mimeType) {
  if (!ai) throw new Error("Gemini API key not configured for image transcription.");


  const imagePart = {
    inlineData: {
      data: buffer.toString("base64"),
      mimeType: mimeType
    },
  };

  const prompt = "Transcribe all text visible in this image accurately. If there are diagrams or charts, provide a brief descriptive summary of them in brackets [].";

  try {
    const response = ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: [prompt, imagePart],
      config: {
        thinkingConfig: {
          thinkingBudget: 0
        }
      }
    });
    const result = response.text;
    return [{ pageNumber: 1, text: result, tokenCount: estimateTokens(result) }];
  } catch (err) {
    console.error("Image transcription failed:", err);
    return [{ pageNumber: 1, text: "[Image transcription failed]", tokenCount: 0 }];
  }
}

// --- Main Unified Extractor ---

export default async function extractContent(file) {
  // Normalize input to Buffer
  const buffer = Buffer.isBuffer(file) ? file : Buffer.from(file);
  // Detect MIME type if possible, or infer from extension/magic bytes?
  // In the controller, we usually have file.mimetype.
  // We'll update the function signature to accept mimetype if available, 
  // or attached to the file object (Multer provides .mimetype).

  const mimeType = file.mimetype || mime.lookup(file.originalname) || 'application/octet-stream';
  const cacheKey = hashBuffer(buffer);

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let processedPages = [];

  try {
    if (mimeType === 'application/pdf') {
      processedPages = await extractPdfText(buffer);
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') { // DOCX
      processedPages = await extractDocxText(buffer);
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') { // PPTX
      processedPages = await extractPptxText(buffer);
    } else if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
      processedPages = await extractTxtText(buffer);
    } else if (mimeType === 'application/epub+zip') {
      processedPages = await extractEpubText(buffer);
    } else if (mimeType.startsWith('image/')) {
      processedPages = await extractImageText(buffer, mimeType);
    } else {
      // Fallback: Try office parser as generic
      try {
        const text = await officeParser.parseOfficeAsync(buffer);
        processedPages = simulatePagination(text);
      } catch (e) {
        console.warn(`Unsupported file type: ${mimeType}`);
        processedPages = [];
      }
    }
  } catch (err) {
    console.error(`Error processing file type ${mimeType}:`, err);
    throw err;
  }

  // Cache and return
  if (processedPages.length > 0) cache.set(cacheKey, processedPages);
  return processedPages;
}