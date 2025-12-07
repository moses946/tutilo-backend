import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Wraps text to fit within a specific width, preserving words.
 */
const wrapLine = (text, font, fontSize, maxWidth) => {
    const words = text.split(' ');
    let lines = [];
    let currentLine = words[0];

    for (let i = 1; i < words.length; i++) {
        const word = words[i];
        const width = font.widthOfTextAtSize(currentLine + " " + word, fontSize);
        if (width < maxWidth) {
            currentLine += (currentLine === '' ? '' : ' ') + word;
        } else {
            lines.push(currentLine);
            currentLine = word;
        }
    }
    lines.push(currentLine);
    return lines;
};

/**
 * Converts text content to PDF, preserving paragraph structure.
 */
export const convertTextToPdf = async (text) => {
    const pdfDoc = await PDFDocument.create();
    let page = pdfDoc.addPage();
    let { width, height } = page.getSize();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    
    // Layout settings
    const fontSize = 11;
    const margin = 50;
    const maxWidth = width - (margin * 2);
    const lineHeight = fontSize * 1.2;
    const paragraphGap = fontSize * 0.8; // Extra space between paragraphs

    const cleanText = text || "No text content found.";
    
    // Split by existing newlines to preserve source paragraphs
    const paragraphs = cleanText.split(/\r?\n/);

    let y = height - margin;

    for (const paragraph of paragraphs) {
        // If paragraph is empty (double newline in source), just add gap
        if (!paragraph.trim()) {
            y -= paragraphGap;
            continue;
        }

        // Wrap the current paragraph
        const lines = wrapLine(paragraph, font, fontSize, maxWidth);

        for (const line of lines) {
            // Check for page break
            if (y < margin) {
                page = pdfDoc.addPage();
                y = height - margin;
            }
            
            page.drawText(line, {
                x: margin,
                y,
                size: fontSize,
                font: font,
                color: rgb(0, 0, 0),
            });
            y -= lineHeight;
        }
        
        // Add gap after every paragraph block
        y -= paragraphGap;
    }

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
};


/**
 * Embeds an image into a PDF page
 */
export const convertImageToPdf = async (imageBuffer, mimeType) => {
    const pdfDoc = await PDFDocument.create();
    let image;

    try {
        if (mimeType === 'image/png') {
            image = await pdfDoc.embedPng(imageBuffer);
        } else if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
            image = await pdfDoc.embedJpg(imageBuffer);
        } else {
            // For unsupported image types in pdf-lib (like webp/heic), 
            // usually we'd convert them to png using 'sharp', 
            // but to avoid heavy dependencies, we fallback to a text page saying unsupported for now
            // or rely on the frontend validation you have set up.
            return convertTextToPdf(`[Image format ${mimeType} conversion to PDF not natively supported without heavy processing libraries]`);
        }

        const page = pdfDoc.addPage([image.width, image.height]);
        page.drawImage(image, {
            x: 0,
            y: 0,
            width: image.width,
            height: image.height,
        });

        const pdfBytes = await pdfDoc.save();
        return Buffer.from(pdfBytes);
    } catch (err) {
        console.error("Image to PDF conversion failed:", err);
        return convertTextToPdf("Error processing image file.");
    }
};