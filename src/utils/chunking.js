import pdfParse from "pdf-parse";
import crypto from "crypto";

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

export default extractPdfText;
// import pdfParse from "pdf-parse";
// import crypto from "crypto";

// // Lightweight in-memory LRU cache to avoid reparsing the same PDF
// const CACHE_SIZE = 5;
// const cache = new Map(); // key -> pagesWithNumbers

// function getCache(key){
//     if(!cache.has(key)) return undefined;
//     const value = cache.get(key);
//     // refresh recency
//     cache.delete(key);
//     cache.set(key, value);
//     return value;
// }

// function setCache(key, value){
//     cache.set(key, value);
//     if(cache.size > CACHE_SIZE){
//         const oldestKey = cache.keys().next().value;
//         cache.delete(oldestKey);
//     }
// }

// async function extractPdfText(file){
//     // file is expected to be a Buffer or Uint8Array
//     const buffer = Buffer.isBuffer(file) ? file : Buffer.from(file);
//     const key = crypto.createHash('sha1').update(buffer).digest('hex');
//     const cached = getCache(key);
//     if(cached) return cached;
    
//     // Use pagerender to control per-page text, append a unique delimiter we can split on
//     const PAGE_SPLIT = '\f';
    
//     const renderPage = (pageData) => {
//         return pageData.getTextContent().then((textContent) => {
//             const items = textContent.items || [];
//             // Preserve line breaks and avoid inserting spaces inside formulas.
//             const text = items.map((item, i, arr) => {
//                 const curr = item.str || '';
//                 const prev = i > 0 ? (arr[i - 1].str || '') : '';
//                 const prevAlphaNum = /[A-Za-z0-9]$/.test(prev);
//                 const currAlphaNum = /^[A-Za-z0-9]/.test(curr);
//                 const needsSpace = prevAlphaNum && currAlphaNum;
//                 const sep = item.hasEOL ? '\n' : (needsSpace ? ' ' : '');
//                 return (sep ? sep : '') + curr;
//             }).join('');
//             return text + PAGE_SPLIT; // mark end of page
//         });
//     };    
    
//     const result = await pdfParse(buffer, { pagerender: renderPage });
//     const raw = result.text || '';
    
//     // Split on our delimiter; keep empty pages to maintain 1-based page numbers
//     let pages = raw.split(PAGE_SPLIT);
    
//     // Map to objects with 1-based page numbers
//     const pagesWithNumbers = pages.map((text, index) => {
//         const cleaned = (text || '').trim();
//         // Estimate token count using rule: 100 tokens ≈ 60-80 words.
//         // Use midpoint 70 words ≈ 100 tokens => tokens ≈ words * (100/70).
//         const wordCount = cleaned.length > 0 ? cleaned.split(/\s+/).filter(Boolean).length : 0;
//         const tokenCount = Math.round(wordCount * (100 / 70));
//         return { pageNumber: index + 1, text: cleaned, tokenCount };
//     });
    
//     // Filter out blank pages entirely
//     let nonBlankPages = pagesWithNumbers.filter(p => p.text && p.text.length > 0);

//     // Enhanced heuristic filter that preserves mathematical content
//     const isNoisyPage = (text) => {
//         const len = text.length;
//         if (len < 10) return true; // extremely short pages
        
//         // Check if page likely contains mathematical content
//         const hasMathIndicators = (text) => {
//             // Common mathematical terms and patterns
//             const mathPatterns = [
//                 /equation/i,
//                 /theorem/i,
//                 /proof/i,
//                 /lemma/i,
//                 /corollary/i,
//                 /definition/i,
//                 /formula/i,
//                 /\d+\s*[+\-*/×÷]\s*\d+/, // Basic arithmetic
//                 /[a-zA-Z]\s*=\s*/, // Variable assignments
//                 /\([^)]*[+\-*/=][^)]*\)/, // Expressions in parentheses
//                 /\b(sin|cos|tan|log|ln|exp|sqrt|lim|sum|int)\b/i, // Math functions
//                 /[∑∫∏∂∇∆√∞∈∉⊂⊃∪∩]/,  // Mathematical symbols
//                 /[αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ]/, // Greek letters
//                 /\^|_\{|_\d/, // Superscript/subscript indicators
//                 /\\[a-zA-Z]+/, // LaTeX commands
//             ];
            
//             return mathPatterns.some(pattern => pattern.test(text));
//         };
        
//         // If the page contains mathematical content, be more lenient
//         const isMathContent = hasMathIndicators(text);
        
//         // Extended allowed characters including more mathematical symbols
//         const allowed = /[A-Za-z0-9\s.,;:()'/±×÷=+\-*^_{}\[\]<>∞≈≠≤≥αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ∑∫∏∂∇∆√∈∉⊂⊃∪∩∀∃∄∅∧∨¬⊕⊗⊥∥∠°′″‴∝∼≅≡≢≪≫⊆⊇⊊⊋∖℘ℕℤℚℝℂ∂∇·×∘∙⊙⊖⊕⊗⊘⊚⊛⊜⊝⊞⊟⊠⊡⟨⟩⟦⟧‖|!@#$%&]/;
        
//         let nonAlnum = 0;
//         for (let i = 0; i < len; i++) {
//             if (!allowed.test(text[i])) nonAlnum++;
//         }
//         const nonAlnumRatio = nonAlnum / len;
        
//         // Adjust threshold based on content type
//         const symbolThreshold = isMathContent ? 0.6 : 0.4; // More lenient for math pages
//         if (nonAlnumRatio > symbolThreshold) return true;
        
//         // Skip TOC detection if this looks like mathematical content
//         if (isMathContent) {
//             return false; // Don't filter out mathematical pages
//         }
        
//         // Original TOC detection logic (only for non-math pages)
//         // Dot leader patterns typical of TOCs
//         const dotLeaders = (text.match(/\.{3,}/g) || []).length;
//         if (dotLeaders >= 5) return true; // Increased threshold
        
//         // Many lines that end with a number (chapter ..... 23)
//         const lines = text.split(/\r?\n/);
//         const leaderOrNumLines = lines.reduce((acc, line) => {
//             return acc + ((/\.{2,}/.test(line) && /\d+$/.test(line.trim())) ? 1 : 0);
//         }, 0);
//         if (leaderOrNumLines >= 5) return true; // Increased threshold
        
//         // TOC keywords - only filter if there are strong indicators
//         const lower = text.toLowerCase();
//         const hasTocKeyword = lower.includes('table of contents') || 
//                               (lower.includes('contents') && dotLeaders >= 2) ||
//                               (lower.includes('index') && dotLeaders >= 2);
//         if (hasTocKeyword && (dotLeaders >= 2 || leaderOrNumLines >= 2)) return true;
        
//         return false;
//     };

//     const filteredPages = nonBlankPages.filter(p => !isNoisyPage(p.text));

//     setCache(key, filteredPages);
//     return filteredPages;
// }
// export default extractPdfText
