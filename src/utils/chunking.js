import pdfParse from "pdf-parse";
import crypto from "crypto";

// Lightweight in-memory LRU cache to avoid reparsing the same PDF
const CACHE_SIZE = 5;
const cache = new Map(); // key -> pagesWithNumbers

function getCache(key){
    if(!cache.has(key)) return undefined;
    const value = cache.get(key);
    // refresh recency
    cache.delete(key);
    cache.set(key, value);
    return value;
}

function setCache(key, value){
    cache.set(key, value);
    if(cache.size > CACHE_SIZE){
        const oldestKey = cache.keys().next().value;
        cache.delete(oldestKey);
    }
}

async function extractPdfText(file){
    // file is expected to be a Buffer or Uint8Array
    const buffer = Buffer.isBuffer(file) ? file : Buffer.from(file);
    const key = crypto.createHash('sha1').update(buffer).digest('hex');
    const cached = getCache(key);
    if(cached) return cached;
    // Use pagerender to control per-page text, append a unique delimiter we can split on
    const PAGE_SPLIT = '\f';
    const renderPage = (pageData) => {
        return pageData.getTextContent().then((textContent) => {
            const text = textContent.items.map((item) => item.str).join(' ');
            return text + PAGE_SPLIT; // mark end of page
        });
    };
    const result = await pdfParse(buffer, { pagerender: renderPage });
    const raw = result.text || '';
    // Split on our delimiter; keep empty pages to maintain 1-based page numbers
    let pages = raw.split(PAGE_SPLIT);
    // Last split chunk after the final delimiter will be empty; keep alignment by not filtering empties here
    // Map to objects with 1-based page numbers
    const pagesWithNumbers = pages.map((text, index) => {
        const cleaned = (text || '').trim();
        // Estimate token count using rule: 100 tokens ≈ 60-80 words.
        // Use midpoint 70 words ≈ 100 tokens => tokens ≈ words * (100/70).
        const wordCount = cleaned.length > 0 ? cleaned.split(/\s+/).filter(Boolean).length : 0;
        const tokenCount = Math.round(wordCount * (100 / 70));
        return { pageNumber: index + 1, text: cleaned, tokenCount };
    });
    // Filter out blank pages entirely
    let nonBlankPages = pagesWithNumbers.filter(p => p.text && p.text.length > 0);

    // Heuristic filter to drop noisy/TOC pages (dot leaders, high symbol density, TOC keywords)
    const isNoisyPage = (text) => {
        const len = text.length;
        if (len < 10) return true; // extremely short

        // Ratio of non-alphanumeric (excluding common punctuation and whitespace)
        const allowed = /[A-Za-z0-9\s.,;:()\-'/]/;
        let nonAlnum = 0;
        for (let i = 0; i < len; i++) {
            if (!allowed.test(text[i])) nonAlnum++;
        }
        const nonAlnumRatio = nonAlnum / len;
        if (nonAlnumRatio > 0.4) return true;

        // Dot leader patterns typical of TOCs
        const dotLeaders = (text.match(/\.{3,}/g) || []).length;
        if (dotLeaders >= 3) return true;

        // Many lines that end with a number (chapter ..... 23)
        const lines = text.split(/\r?\n/);
        const leaderOrNumLines = lines.reduce((acc, line) => acc + ((/\.{2,}/.test(line) && /\d+$/.test(line.trim())) ? 1 : 0), 0);
        if (leaderOrNumLines >= 3) return true;

        // TOC keywords
        const lower = text.toLowerCase();
        const hasTocKeyword = lower.includes('table of contents') || lower.includes('contents') || lower.includes('index') || lower.includes('chapters');
        if (hasTocKeyword && (dotLeaders >= 1 || leaderOrNumLines >= 1)) return true;

        return false;
    };

    const filteredPages = nonBlankPages.filter(p => !isNoisyPage(p.text));

    setCache(key, filteredPages);
    return filteredPages;
}

export default extractPdfText
