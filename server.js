const express = require('express');
const path = require('path');
const cors = require('cors');
const scrapeHandler = require('./api/scrape');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Scrape endpoint - reuses the same handler as the Vercel serverless function
app.post('/api/scrape', (req, res) => scrapeHandler(req, res));

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Cleanup on exit
process.on('SIGINT', async () => {
  process.exit();
});

process.on('SIGTERM', async () => {
  process.exit();
});

app.listen(PORT, () => {
  console.log(`\n  StudyForge is running at http://localhost:${PORT}\n`);
});
