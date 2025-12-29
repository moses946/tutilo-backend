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
  allowedChars: /[A-Za-z0-9\s.,;:()'/±×÷=+\-*^_{}\[\]<>∞≈≠≤≥αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ∑∫∏∂∇∆√∈∉⊂⊃∪∩∀∃∄∅∧∨¬⊕⊗⊥∥∠°′″‴∝∼≅≡≢≪≫⊆⊇⊊⊋∖℘ℕℤℚℝℂ·×∘∙⊙⊖⊕⊗⊘⊚⊛⊜⊝⊞⊟⊠⊡⟨⟩⟦⟧‖|!@#$%&\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]/
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

  // Strategy 1: Standard PDF Parsing (Fast, no API cost)
  try {
    const result = await pdfParse(buffer, { pagerender: renderPage });
    const pages = (result.text || '').split(PAGE_SPLIT);

    const processedPages = pages
      .map((text, index) => {
        const cleaned = text.trim();
        return {
          pageNumber: index + 1,
          text: cleaned,
          tokenCount: estimateTokens(cleaned)
        };
      })
      .filter(p => p.text.length > 0)
      .filter(p => !isNoisyPage(p.text));

    // If standard parsing works and finds substantial text, return it.
    // We check for a minimal length to ensure it's not just page numbers or artifacts.
    const totalTextLength = processedPages.reduce((acc, p) => acc + p.text.length, 0);
    if (processedPages.length > 0 && totalTextLength > 50) {
      cache.set(cacheKey, processedPages);
      return processedPages;
    }
    console.log("Standard PDF parsing yielded insufficient text. Attempting AI OCR...");
  } catch (e) {
    console.warn("Standard PDF parsing failed. Attempting AI OCR...", e);
  }

  // Strategy 2: Gemini 1.5 Flash OCR (Handles scans & translations)
  if (!ai) {
    console.error("Gemini API not configured. Cannot perform OCR on scanned PDF.");
    return [];
  }

  try {
    const model = "gemini-2.0-flash";
    const pdfPart = {
      inlineData: {
        data: buffer.toString("base64"),
        mimeType: "application/pdf"
      },
    };

    const prompt = `
      You are an advanced OCR and translation engine.
      Task: Extract all text from this PDF document.
      
      Instructions:
      1. Transcribe the content of every page accurately.
      2. If the text is in a language other than English (e.g., Chinese, Georgian), translate it to English.
      3. For math formulas, convert them to LaTeX or clear text representation.
      4. Insert the delimiter "<<<PAGE_BREAK>>>" exactly between pages. 
      5. Output ONLY the extracted/translated text. No intro or markdown code blocks.
    `;

    const response = await ai.models.generateContent({
      model: model,
      contents: [{ role: 'user', parts: [{ text: prompt }, pdfPart] }],
      config: {
        temperature: 0.1,      // Low temp for accuracy
      }
    });

    const fullText = response.text || "";

    // Split by the specific delimiter requested in the prompt
    const rawPages = fullText.split("<<<PAGE_BREAK>>>");

    const ocrPages = rawPages.map((text, index) => {
      const cleaned = text.trim();
      return {
        pageNumber: index + 1,
        text: cleaned,
        tokenCount: estimateTokens(cleaned)
      };
    }).filter(p => p.text.length > 0);

    if (ocrPages.length > 0) {
      cache.set(cacheKey, ocrPages);
      return ocrPages;
    }

    return [];

  } catch (err) {
    console.error("Gemini OCR Fallback Failed:", err.message);
    // Return empty array so the controller handles it as "No text extracted"
    return [];
  }
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
    // Note: epub2 usually expects a file path. 
    // For robust buffer handling, saving to tmp might be required, 
    // but here we try officeParser as a fallback for generic parsing if epub2 fails on buffer.
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

  const prompt = `
    Task: Optical Character Recognition (OCR) & Translation.
    1. Transcribe all text visible in this image accurately.
    2. If the text is in a language other than English, translate it to English immediately following the original text.
    3. If there are diagrams or charts, provide a brief descriptive summary of them in brackets [].
    4. Output plain text only.
  `;
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash", // Using fast model as requested
      contents: [{ role: 'user', parts: [{ text: prompt }, imagePart] }],
      config: {
        thinkingConfig: { thinkingBudget: 0 }
      }
    });

    // Based on your models.js usage:
    return [{ pageNumber: 1, text: response.text || "", tokenCount: estimateTokens(response.text || "") }];
  } catch (err) {
    console.error("Image transcription failed:", err);
    return [{ pageNumber: 1, text: "[Image transcription failed]", tokenCount: 0 }];
  }
}

// Helper to simulate paging for non-paginated formats
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

// --- UPDATE MAIN EXPORT ---

export default async function extractContent(file) {
  const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer);
  // Detect MIME type more robustly
  const mimeType = file.mimetype || mime.lookup(file.originalname) || 'application/octet-stream';
  const cacheKey = hashBuffer(buffer);

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

  if (processedPages.length > 0) cache.set(cacheKey, processedPages);
  return processedPages;
}
