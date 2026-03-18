const express = require('express');
const path = require('path');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Reusable browser instance
let browser = null;

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    });
  }
  return browser;
}

// Scrape Quizlet flashcard set using Puppeteer
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!url.includes('quizlet.com')) {
    return res.status(400).json({ error: 'Please provide a valid Quizlet URL' });
  }

  // Clean the URL (remove query params like funnelUUID)
  let cleanUrl = url.split('?')[0];
  if (!cleanUrl.endsWith('/')) cleanUrl += '/';

  let page = null;

  try {
    const b = await getBrowser();
    page = await b.newPage();

    // Stealth: override navigator.webdriver
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    await page.setViewport({ width: 1280, height: 900 });

    // Use domcontentloaded - networkidle2 hangs on Quizlet due to constant background requests
    await page.goto(cleanUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait for JS to render
    await new Promise(r => setTimeout(r, 4000));

    // Extract cards using all strategies, keep the one that finds the most
    const result = await page.evaluate(() => {
      let title = '';

      // Get title
      const h1 = document.querySelector('h1');
      if (h1) title = h1.textContent.trim();
      if (!title) {
        const titleEl = document.querySelector('title');
        if (titleEl) title = titleEl.textContent.replace(/\s*[\||\-]\s*Quizlet.*$/, '').trim();
      }

      // Helper to deduplicate a card array
      const dedup = (arr) => {
        const seen = new Set();
        return arr.filter(c => {
          const key = `${c.term}::${c.definition}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      };

      // Run ALL strategies and collect results separately
      const results = [];

      // Strategy 1: JSON-LD Quiz schema
      const jsonLdCards = [];
      document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
        try {
          const data = JSON.parse(el.textContent);
          if (data['@type'] === 'Quiz' && data.hasPart) {
            const parts = Array.isArray(data.hasPart) ? data.hasPart : [data.hasPart];
            parts.forEach(part => {
              if (part['@type'] === 'Question' && part.text && part.acceptedAnswer) {
                const answer = part.acceptedAnswer;
                const def = answer.text || (typeof answer === 'string' ? answer : '');
                if (part.text && def) jsonLdCards.push({ term: part.text, definition: def });
              }
            });
          }
          if (data['@type'] === 'ItemList' && data.itemListElement) {
            data.itemListElement.forEach(item => {
              if (item.item && item.item.name && item.item.acceptedAnswer) {
                jsonLdCards.push({ term: item.item.name, definition: item.item.acceptedAnswer.text });
              }
            });
          }
        } catch (e) {}
      });
      if (jsonLdCards.length > 0) results.push(dedup(jsonLdCards));

      // Strategy 2a: DOM - SetPageTermsList-term rows (includes hidden signup-wall terms)
      const domCards1 = [];
      document.querySelectorAll('.SetPageTermsList-term').forEach(row => {
        const termTexts = row.querySelectorAll('.TermText');
        if (termTexts.length >= 2) {
          const term = termTexts[0].textContent.trim();
          const def = termTexts[1].textContent.trim();
          if (term && def) domCards1.push({ term, definition: def });
        }
      });
      if (domCards1.length > 0) results.push(dedup(domCards1));

      // Strategy 2b: All paired TermText elements
      const domCards2 = [];
      const allTermTexts = document.querySelectorAll('.TermText');
      for (let i = 0; i < allTermTexts.length - 1; i += 2) {
        const term = allTermTexts[i].textContent.trim();
        const def = allTermTexts[i + 1].textContent.trim();
        if (term && def && term !== def) domCards2.push({ term, definition: def });
      }
      if (domCards2.length > 0) results.push(dedup(domCards2));

      // Strategy 2c: data-testid based
      const domCards3 = [];
      const termEls = document.querySelectorAll('[data-testid="Term"]');
      const defEls = document.querySelectorAll('[data-testid="Definition"]');
      const pairCount = Math.min(termEls.length, defEls.length);
      for (let i = 0; i < pairCount; i++) {
        const term = termEls[i].textContent.trim();
        const def = defEls[i].textContent.trim();
        if (term && def) domCards3.push({ term, definition: def });
      }
      if (domCards3.length > 0) results.push(dedup(domCards3));

      // Strategy 3: Extract from script tags containing word/definition data
      const scriptCards = [];
      document.querySelectorAll('script').forEach(el => {
        const text = el.textContent || '';
        if (!text.includes('"word"') || !text.includes('"definition"')) return;
        const regex = /"word"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
        const defRegex = /"definition"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
        const words = [];
        const defs = [];
        let m;
        while ((m = regex.exec(text)) !== null) {
          try { words.push(JSON.parse(`"${m[1]}"`)); } catch(e) { words.push(m[1]); }
        }
        while ((m = defRegex.exec(text)) !== null) {
          try { defs.push(JSON.parse(`"${m[1]}"`)); } catch(e) { defs.push(m[1]); }
        }
        const cnt = Math.min(words.length, defs.length);
        for (let i = 0; i < cnt; i++) {
          if (words[i] && defs[i]) scriptCards.push({ term: words[i], definition: defs[i] });
        }
      });
      if (scriptCards.length > 0) results.push(dedup(scriptCards));

      // Pick the strategy that found the most cards
      let best = [];
      for (const r of results) {
        if (r.length > best.length) best = r;
      }

      return { title, cards: best };
    });

    await page.close();

    if (result.cards.length === 0) {
      return res.status(404).json({
        error: 'Could not extract flashcards. The set may be private or require login. Try the "Paste Terms" tab instead.',
        suggestion: 'manual'
      });
    }

    res.json({
      title: result.title,
      cards: result.cards,
      count: result.cards.length
    });

  } catch (error) {
    console.error('Scrape error:', error.message);
    if (page) await page.close().catch(() => {});
    res.status(500).json({
      error: `Failed to fetch flashcards: ${error.message}`,
      suggestion: 'manual'
    });
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Cleanup on exit
process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit();
});

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit();
});

app.listen(PORT, () => {
  console.log(`\n  StudyForge is running at http://localhost:${PORT}\n`);
});
