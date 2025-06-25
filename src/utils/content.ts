import { JSDOM } from 'jsdom';
import DOMPurify from 'isomorphic-dompurify';

export interface CleanedContent {
  text: string;
  html: string;
}

/**
 * Extract and clean content from HTML
 */
export function extractCleanContent(html: string): CleanedContent {
  try {
    // Create DOM from HTML
    const dom = new JSDOM(html);
    const window = dom.window;
    
    // Sanitize HTML
    const cleanHtml = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [
        "p",
        "br",
        "strong",
        "em",
        "a",
        "ul",
        "ol",
        "li",
        "blockquote",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
      ],
      ALLOWED_ATTR: ["href", "title"],
    });
    
    // Extract text content
    const textContent = window.document.createElement('div');
    textContent.innerHTML = cleanHtml;
    const text = textContent.textContent || '';
    
    return {
      text: text.trim().replace(/\s+/g, ' '),
      html: cleanHtml,
    };
  } catch (error) {
    // Fallback for non-HTML content
    return {
      text: html.replace(/<[^>]*>/g, '').trim().replace(/\s+/g, ' '),
      html: html,
    };
  }
}

/**
 * Sanitize string for use as ID
 */
export function sanitizeString(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
