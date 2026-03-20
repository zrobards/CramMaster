// ===== StudyForge - Adaptive Learning Engine =====

(function () {
  'use strict';

  // ===== STATE =====
  const state = {
    cards: [],           // { term, definition }
    setTitle: '',
    // Per-card learning state
    cardState: [],       // { cardIndex, bucket, correctStreak, incorrectCount, lastSeen, nextReview, easeFactor }
    // Session state
    session: {
      queue: [],         // indices into cardState
      currentIndex: 0,
      questionNum: 0,
      totalQuestions: 0,
      correctCount: 0,
      incorrectCount: 0,
      bestStreak: 0,
      currentStreak: 0,
      roundSize: 10,
      answered: false,
    },
    // Settings
    settings: {
      questionTypes: ['mc', 'tf', 'written'],
      direction: 'term',   // term, definition, both
      audio: false,
    },
    audioEnabled: false,
  };

  // Bucket thresholds for mastery
  const BUCKET = {
    NEW: 0,
    LEARNING: 1,
    REVIEWING: 2,
    MASTERED: 3,
  };

  const MASTERY_STREAK = 3; // Correct answers in a row to master

  // ===== DOM REFS =====
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const screens = {
    import: $('#screen-import'),
    overview: $('#screen-overview'),
    learn: $('#screen-learn'),
    results: $('#screen-results'),
  };

  // ===== NAVIGATION =====
  function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[name].classList.add('active');
  }

  // ===== STORAGE =====
  function saveSet() {
    const saved = JSON.parse(localStorage.getItem('studyforge_sets') || '{}');
    const key = state.setTitle || 'Untitled Set';
    saved[key] = {
      title: state.setTitle,
      cards: state.cards,
      cardState: state.cardState,
      lastStudied: Date.now(),
    };
    localStorage.setItem('studyforge_sets', JSON.stringify(saved));
  }

  function loadSavedSets() {
    const saved = JSON.parse(localStorage.getItem('studyforge_sets') || '{}');
    const section = $('#saved-sets-section');
    const list = $('#saved-sets-list');
    const entries = Object.entries(saved);

    if (entries.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    list.innerHTML = '';

    // Sort by most recent
    entries.sort((a, b) => b[1].lastStudied - a[1].lastStudied);

    entries.forEach(([key, data]) => {
      const mastered = (data.cardState || []).filter(c => c.bucket >= BUCKET.MASTERED).length;
      const total = data.cards.length;
      const pct = total > 0 ? Math.round((mastered / total) * 100) : 0;

      const item = document.createElement('div');
      item.className = 'saved-set-item';
      item.innerHTML = `
        <div class="saved-set-info">
          <span class="saved-set-title">${escapeHtml(data.title || key)}</span>
          <span class="saved-set-meta">${total} terms &middot; ${pct}% mastered &middot; ${timeAgo(data.lastStudied)}</span>
        </div>
        <div class="saved-set-actions">
          <button class="btn-delete-set" data-key="${escapeHtml(key)}" title="Delete">&times;</button>
        </div>
      `;

      item.addEventListener('click', (e) => {
        if (e.target.closest('.btn-delete-set')) return;
        state.cards = data.cards;
        state.setTitle = data.title || key;
        state.cardState = data.cardState || initCardState(data.cards);
        showOverview();
      });

      const deleteBtn = item.querySelector('.btn-delete-set');
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        delete saved[key];
        localStorage.setItem('studyforge_sets', JSON.stringify(saved));
        loadSavedSets();
      });

      list.appendChild(item);
    });
  }

  // ===== IMPORT =====
  function setupImport() {
    // Tab switching
    $$('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.tab-btn').forEach(b => b.classList.remove('active'));
        $$('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        $(`#tab-${btn.dataset.tab}`).classList.add('active');
      });
    });

    // URL import
    $('#btn-import').addEventListener('click', importFromUrl);
    $('#quizlet-url').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') importFromUrl();
    });

    // Manual import
    $('#btn-parse-manual').addEventListener('click', importManual);

    loadSavedSets();
  }

  // Endpoints to try in order: local server first, then Cloudflare Worker fallback
  const SCRAPE_ENDPOINTS = [
    '/api/scrape',
    'https://quizlet-scraper.zacharyrobards.workers.dev',
  ];

  async function importFromUrl() {
    const url = $('#quizlet-url').value.trim();
    const status = $('#import-status');
    const btn = $('#btn-import');

    if (!url) {
      status.textContent = 'Please enter a URL.';
      status.className = 'status-msg error';
      return;
    }

    btn.disabled = true;
    status.innerHTML = '<span class="spinner"></span>Fetching flashcards... this may take a few seconds';
    status.className = 'status-msg loading';

    let lastError = '';

    for (const endpoint of SCRAPE_ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });

        const data = await res.json();

        if (res.ok && data.cards && data.cards.length > 0) {
          state.cards = data.cards;
          state.setTitle = data.title || 'Imported Set';
          state.cardState = initCardState(data.cards);

          status.textContent = `Loaded ${data.count} terms!`;
          status.className = 'status-msg success';

          saveSet();
          setTimeout(() => showOverview(), 500);
          btn.disabled = false;
          return;
        }

        lastError = data.error || 'No cards found';
      } catch (err) {
        lastError = err.message;
      }
    }

    // All endpoints failed — show helpful export instructions
    status.innerHTML = `
      <strong>Could not auto-import this set.</strong> Quizlet blocks automated access.<br><br>
      <strong>Quick workaround:</strong><br>
      1. Open your Quizlet set<br>
      2. Click the <strong>⋯</strong> menu → <strong>Export</strong><br>
      3. Copy all the text<br>
      4. Switch to the <strong>"Paste Terms"</strong> tab here and paste it
    `;
    status.className = 'status-msg error';
    btn.disabled = false;
  }

  function importManual() {
    const text = $('#manual-terms').value.trim();
    if (!text) return;

    const lines = text.split('\n').filter(l => l.trim());
    const cards = [];

    for (const line of lines) {
      let term, definition;

      if (line.includes('::')) {
        // Double colon separator
        const parts = line.split('::').map(s => s.trim());
        if (parts.length >= 2) { term = parts[0]; definition = parts.slice(1).join('::').trim(); }
      } else if (line.includes('\t')) {
        // Tab separator
        const parts = line.split('\t').map(s => s.trim());
        if (parts.length >= 2) { term = parts[0]; definition = parts.slice(1).join('\t').trim(); }
      } else if (line.includes(':')) {
        // Single colon — split on the LAST colon that's followed by a space and text
        // This handles "Case Name (year): definition" and "Case Name (year):definition"
        // Find the best split point: look for ): or a colon after a closing paren/year
        const colonMatch = line.match(/^(.+?)\)\s*:\s*(.+)$/) ||  // "Term (year): def"
                           line.match(/^(.+?)\s*:\s*(.{15,})$/);   // "Term: long definition" (def must be 15+ chars)
        if (colonMatch) {
          term = colonMatch[1].trim();
          definition = colonMatch[2].trim();
          // Re-add closing paren if it was in the first match group
          if (!term.endsWith(')') && line.includes(')')) {
            term = term + ')';
          }
        }
      }

      if (term && definition) {
        cards.push({ term, definition });
      }
    }

    if (cards.length === 0) {
      alert('No valid term/definition pairs found. Separate terms and definitions with a colon (:), double colon (::), or tab.');
      return;
    }

    state.cards = cards;
    state.setTitle = 'My Study Set';
    state.cardState = initCardState(cards);
    saveSet();
    showOverview();
  }

  // ===== CARD STATE INITIALIZATION =====
  function initCardState(cards) {
    return cards.map((_, i) => ({
      cardIndex: i,
      bucket: BUCKET.NEW,
      correctStreak: 0,
      incorrectCount: 0,
      lastSeen: 0,
      nextReview: 0,
      easeFactor: 2.5,  // SM-2 starting ease
    }));
  }

  // ===== OVERVIEW =====
  function showOverview() {
    showScreen('overview');

    const titleEl = $('#set-title');
    const titleInput = $('#set-title-input');
    titleEl.textContent = state.setTitle;
    titleEl.style.display = '';
    titleInput.style.display = 'none';
    $('#set-count').textContent = `${state.cards.length} terms`;

    // Click title to rename
    titleEl.onclick = () => {
      titleEl.style.display = 'none';
      titleInput.style.display = '';
      titleInput.value = state.setTitle;
      titleInput.focus();
      titleInput.select();
    };

    const finishRename = () => {
      const newName = titleInput.value.trim();
      if (newName && newName !== state.setTitle) {
        // Remove old key from storage
        const saved = JSON.parse(localStorage.getItem('studyforge_sets') || '{}');
        delete saved[state.setTitle];
        localStorage.setItem('studyforge_sets', JSON.stringify(saved));

        state.setTitle = newName;
        saveSet();
      }
      titleEl.textContent = state.setTitle;
      titleEl.style.display = '';
      titleInput.style.display = 'none';
    };

    titleInput.onblur = finishRename;
    titleInput.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finishRename(); }
      if (e.key === 'Escape') { titleEl.style.display = ''; titleInput.style.display = 'none'; }
    };

    renderTermsList();

    // Add term button
    $('#btn-add-term').onclick = () => {
      // Scroll to bottom of terms list and show add form if not already there
      const preview = $('#terms-preview');
      if (!preview.querySelector('.add-term-row')) {
        const addRow = document.createElement('div');
        addRow.className = 'add-term-row';
        addRow.innerHTML = `
          <input type="text" class="add-term-input" placeholder="Term" />
          <input type="text" class="add-def-input" placeholder="Definition" />
          <button class="btn-primary btn-sm add-term-save">Add</button>
        `;
        preview.appendChild(addRow);

        const termInput = addRow.querySelector('.add-term-input');
        const defInput = addRow.querySelector('.add-def-input');
        const saveBtn = addRow.querySelector('.add-term-save');

        termInput.focus();

        const addCard = () => {
          const term = termInput.value.trim();
          const def = defInput.value.trim();
          if (!term || !def) return;

          state.cards.push({ term, definition: def });
          // Add matching card state
          state.cardState.push({
            cardIndex: state.cards.length - 1,
            bucket: BUCKET.NEW,
            correctStreak: 0,
            incorrectCount: 0,
            lastSeen: 0,
            nextReview: 0,
            easeFactor: 2.5,
          });

          saveSet();
          renderTermsList();
          $('#set-count').textContent = `${state.cards.length} terms`;

          // Re-add the add row for quick multi-add
          $('#btn-add-term').onclick();
        };

        saveBtn.onclick = addCard;
        defInput.onkeydown = (e) => { if (e.key === 'Enter') addCard(); };
        termInput.onkeydown = (e) => { if (e.key === 'Enter') defInput.focus(); };
      } else {
        preview.querySelector('.add-term-input').focus();
      }

      preview.scrollTop = preview.scrollHeight;
    };

    $('#btn-back-import').onclick = () => {
      showScreen('import');
      loadSavedSets();
    };

    $('#btn-start-learn').onclick = startLearnSession;
  }

  function renderTermsList() {
    const preview = $('#terms-preview');
    preview.innerHTML = '';

    state.cards.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'term-row';
      row.innerHTML = `
        <div class="term-word">${escapeHtml(c.term)}</div>
        <div class="term-def">${escapeHtml(c.definition)}</div>
        <div class="term-actions">
          <button class="term-action-btn edit" title="Edit">&#9998;</button>
          <button class="term-action-btn delete" title="Delete">&times;</button>
        </div>
      `;

      // Edit button
      row.querySelector('.edit').onclick = (e) => {
        e.stopPropagation();
        startEditTerm(row, i);
      };

      // Delete button
      row.querySelector('.delete').onclick = (e) => {
        e.stopPropagation();
        state.cards.splice(i, 1);
        state.cardState.splice(i, 1);
        // Fix cardIndex references
        state.cardState.forEach((cs, idx) => { cs.cardIndex = idx; });
        saveSet();
        renderTermsList();
        $('#set-count').textContent = `${state.cards.length} terms`;
      };

      preview.appendChild(row);
    });
  }

  function startEditTerm(row, index) {
    const card = state.cards[index];
    row.className = 'term-row editing';
    row.innerHTML = `
      <input type="text" class="term-edit-input" value="${escapeHtml(card.term)}" />
      <input type="text" class="term-edit-input" value="${escapeHtml(card.definition)}" />
      <div class="term-edit-actions">
        <button class="btn-primary btn-sm save-edit">Save</button>
        <button class="btn-ghost btn-sm cancel-edit">Cancel</button>
      </div>
    `;

    const inputs = row.querySelectorAll('.term-edit-input');
    const termInput = inputs[0];
    const defInput = inputs[1];
    termInput.focus();

    const save = () => {
      const newTerm = termInput.value.trim();
      const newDef = defInput.value.trim();
      if (newTerm && newDef) {
        state.cards[index] = { term: newTerm, definition: newDef };
        saveSet();
      }
      renderTermsList();
    };

    row.querySelector('.save-edit').onclick = save;
    row.querySelector('.cancel-edit').onclick = () => renderTermsList();
    defInput.onkeydown = (e) => { if (e.key === 'Enter') save(); };
    termInput.onkeydown = (e) => { if (e.key === 'Enter') defInput.focus(); };
  }

  // ===== LEARN SESSION =====

  function startLearnSession() {
    state.settings.audio = $('#opt-audio').checked;
    state.settings.direction = document.querySelector('input[name="direction"]:checked')?.value || 'def-to-term';
    state.settings.mode = document.querySelector('input[name="mode"]:checked')?.value || 'both';

    // Queue all cards, randomized. Wrong answers get re-queued.
    const allCards = state.cardState.map(c => c.cardIndex);
    shuffleArray(allCards);

    state.session.queue = allCards;
    state.session.currentIndex = 0;
    state.session.questionNum = 0;
    state.session.totalQuestions = allCards.length;
    state.session.correctCount = 0;
    state.session.incorrectCount = 0;
    state.session.bestStreak = 0;
    state.session.currentStreak = 0;
    state.session.answered = false;

    showScreen('learn');
    updateProgress();
    showNextQuestion();
  }

  function updateProgress() {
    const mastered = state.cardState.filter(c => c.bucket >= BUCKET.MASTERED).length;
    const learning = state.cardState.filter(c => c.bucket === BUCKET.LEARNING || c.bucket === BUCKET.REVIEWING).length;
    const remaining = state.cardState.filter(c => c.bucket === BUCKET.NEW).length;
    const total = state.cards.length;

    $('#stat-mastered').textContent = mastered;
    $('#stat-learning').textContent = learning;
    $('#stat-remaining').textContent = remaining;

    const done = state.session.currentIndex;
    const queueLen = state.session.queue.length;
    const pct = queueLen > 0 ? (done / queueLen) * 100 : 0;
    $('#progress-fill').style.width = `${pct}%`;
  }

  function showNextQuestion() {
    const session = state.session;

    if (session.currentIndex >= session.queue.length) {
      showResults();
      return;
    }

    session.questionNum++;
    session.answered = false;

    const cardIdx = session.queue[session.currentIndex];
    const card = state.cards[cardIdx];

    // Hide all question types and feedback
    $('#mc-options').style.display = 'none';
    $('#tf-options').style.display = 'none';
    $('#written-input').style.display = 'none';
    $('#feedback').style.display = 'none';

    // Determine direction for this question
    let questionText, answer;
    const dir = state.settings.direction;
    let showingTerm;

    if (dir === 'both') {
      showingTerm = Math.random() < 0.5;
    } else if (dir === 'term-to-def') {
      showingTerm = true;
    } else {
      showingTerm = false;
    }

    if (showingTerm) {
      questionText = card.term;
      answer = card.definition;
    } else {
      questionText = card.definition;
      answer = card.term;
    }

    state.session.currentShowingTerm = showingTerm;

    $('#question-counter').textContent = `${session.currentIndex + 1} / ${session.queue.length}`;

    // Pick question type based on mode setting
    const mode = state.settings.mode;
    let qType;
    if (mode === 'mc') {
      qType = 'mc';
    } else if (mode === 'written') {
      qType = 'written';
    } else {
      // both — randomize
      qType = Math.random() < 0.5 ? 'mc' : 'written';
    }

    let promptLabel;
    if (qType === 'mc') {
      promptLabel = showingTerm ? 'Select the correct definition' : 'Select the correct term';
      $('#question-type-badge').textContent = 'Multiple Choice';
      if (state.settings.audio) speak(questionText);
      showMultipleChoice(questionText, answer, cardIdx, promptLabel);
    } else {
      promptLabel = showingTerm ? 'Type the definition' : 'Type the term';
      $('#question-type-badge').textContent = 'Fill in the Blank';
      if (state.settings.audio) speak(questionText);
      showWritten(questionText, answer, cardIdx, promptLabel);
    }
  }

  // ===== QUESTION TYPES =====

  function showMultipleChoice(question, correctAnswer, cardIdx, promptLabel) {
    $('#question-type-badge').textContent = 'Multiple Choice';
    $('#question-prompt').innerHTML = `<small style="color:var(--text-muted)">${promptLabel}</small><br>${escapeHtml(question)}`;

    // Generate distractors
    const options = generateDistractors(correctAnswer, cardIdx, 3);
    options.push(correctAnswer);
    shuffleArray(options);

    const container = $('#mc-options');
    container.style.display = 'flex';
    container.innerHTML = '';

    const letters = ['A', 'B', 'C', 'D'];
    options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'mc-option';
      btn.innerHTML = `<span class="option-letter">${letters[i]}</span><span>${escapeHtml(opt)}</span>`;
      btn.addEventListener('click', () => {
        if (state.session.answered) return;
        handleAnswer(opt === correctAnswer, correctAnswer, container.querySelectorAll('.mc-option'), btn, cardIdx);
      });
      container.appendChild(btn);
    });

    // Keyboard shortcuts
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (state.session.answered) {
        document.removeEventListener('keydown', handler);
        return;
      }
      const idx = { '1': 0, '2': 1, '3': 2, '4': 3, 'a': 0, 'b': 1, 'c': 2, 'd': 3 }[e.key.toLowerCase()];
      if (idx !== undefined && idx < container.children.length) {
        container.children[idx].click();
        document.removeEventListener('keydown', handler);
      }
    };
    document.addEventListener('keydown', handler);
  }

  function showTrueFalse(question, correctAnswer, cardIdx, promptLabel) {
    $('#question-type-badge').textContent = 'True / False';

    // 50% chance to show correct answer, 50% to show wrong one
    const showCorrect = Math.random() < 0.5;
    let displayedAnswer;

    if (showCorrect) {
      displayedAnswer = correctAnswer;
    } else {
      const distractors = generateDistractors(correctAnswer, cardIdx, 1);
      displayedAnswer = distractors[0] || correctAnswer;
    }

    const isTrue = displayedAnswer === correctAnswer;

    $('#question-prompt').innerHTML = `
      <small style="color:var(--text-muted)">${promptLabel}</small><br>
      ${escapeHtml(question)}<br>
      <div style="margin-top:0.75rem;padding:0.75rem;background:var(--bg-input);border-radius:var(--radius-sm);border:1px solid var(--border);">
        ${escapeHtml(displayedAnswer)}
      </div>
    `;

    const container = $('#tf-options');
    container.style.display = 'flex';

    // Reset buttons
    container.querySelectorAll('.tf-btn').forEach(btn => {
      btn.className = 'tf-btn';
      btn.onclick = null;
    });

    container.querySelectorAll('.tf-btn').forEach(btn => {
      btn.addEventListener('click', function handler() {
        if (state.session.answered) return;
        const userAnswer = btn.dataset.answer === 'true';
        const correct = userAnswer === isTrue;
        handleTFAnswer(correct, correctAnswer, container.querySelectorAll('.tf-btn'), btn, isTrue, cardIdx);
        btn.removeEventListener('click', handler);
      });
    });

    // Keyboard
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (state.session.answered) return;
      if (e.key === 't' || e.key === 'T') container.querySelector('[data-answer="true"]').click();
      if (e.key === 'f' || e.key === 'F') container.querySelector('[data-answer="false"]').click();
      document.removeEventListener('keydown', handler);
    };
    document.addEventListener('keydown', handler);
  }

  function showWritten(question, correctAnswer, cardIdx, promptLabel) {
    $('#question-type-badge').textContent = 'Written';
    $('#question-prompt').innerHTML = `<small style="color:var(--text-muted)">${promptLabel}</small><br>${escapeHtml(question)}`;

    const container = $('#written-input');
    container.style.display = 'flex';
    const input = $('#written-answer');
    input.value = '';
    input.focus();

    const submit = () => {
      if (state.session.answered) return;
      const userAnswer = input.value.trim();
      if (!userAnswer) return;
      const correct = checkWrittenAnswer(userAnswer, correctAnswer);
      handleWrittenAnswer(correct, correctAnswer, cardIdx);
    };

    $('#btn-submit-written').onclick = submit;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
    };
  }

  function checkWrittenAnswer(user, correct) {
    const normalize = (s) => s.toLowerCase().trim()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ');

    const u = normalize(user);
    const c = normalize(correct);

    // Exact match after normalization
    if (u === c) return true;

    // Levenshtein fuzzy match — 25% tolerance
    const distance = levenshtein(u, c);
    const threshold = Math.max(2, Math.floor(c.length * 0.25));
    if (distance <= threshold) return true;

    // Check if user's answer contains most key words from the correct answer
    const stopWords = new Set(['the', 'a', 'an', 'is', 'was', 'are', 'were', 'of', 'in', 'to', 'and', 'or', 'that', 'for', 'it', 'on', 'by', 'with', 'as', 'at', 'from', 'this', 'be', 'has', 'had', 'not', 'but', 'its']);
    const correctWords = c.split(' ').filter(w => w.length > 2 && !stopWords.has(w));
    const userWords = u.split(' ');

    if (correctWords.length > 0) {
      // Count how many key words from the correct answer appear in the user's answer (with fuzzy matching per word)
      let matched = 0;
      for (const cw of correctWords) {
        const found = userWords.some(uw => {
          if (uw === cw) return true;
          if (cw.length > 3 && levenshtein(uw, cw) <= 1) return true; // Allow 1-char typo per word
          if (cw.length > 5 && uw.includes(cw.substring(0, Math.ceil(cw.length * 0.7)))) return true; // Partial match
          return false;
        });
        if (found) matched++;
      }
      const matchRatio = matched / correctWords.length;
      if (matchRatio >= 0.6) return true; // 60% of key words matched
    }

    // Check if correct answer contains most of user's key words (user might phrase it differently)
    const userKeyWords = u.split(' ').filter(w => w.length > 2 && !stopWords.has(w));
    if (userKeyWords.length > 0) {
      let matched = 0;
      for (const uw of userKeyWords) {
        const found = correctWords.some(cw => {
          if (cw === uw) return true;
          if (uw.length > 3 && levenshtein(uw, cw) <= 1) return true;
          return false;
        });
        if (found) matched++;
      }
      const matchRatio = matched / userKeyWords.length;
      if (matchRatio >= 0.6 && userKeyWords.length >= 2) return true;
    }

    return false;
  }

  function levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b[i - 1] === a[j - 1]) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }

  // ===== ANSWER HANDLING =====

  function handleAnswer(correct, correctAnswer, allBtns, clickedBtn, cardIdx) {
    state.session.answered = true;

    allBtns.forEach(btn => {
      btn.classList.add('disabled');
      const text = btn.querySelector('span:last-child').textContent;
      if (text === correctAnswer) btn.classList.add('correct');
    });

    if (!correct) {
      clickedBtn.classList.add('incorrect');
      clickedBtn.classList.add('shake');
    } else {
      clickedBtn.classList.add('pop');
    }

    updateCardState(cardIdx, correct);
    showFeedback(correct, correctAnswer, cardIdx, false);
  }

  function handleTFAnswer(correct, correctAnswer, allBtns, clickedBtn, isTrue, cardIdx) {
    state.session.answered = true;

    allBtns.forEach(btn => {
      btn.classList.add('disabled');
      const isCorrectBtn = (btn.dataset.answer === 'true') === isTrue;
      if (isCorrectBtn) btn.classList.add('correct');
    });

    if (!correct) {
      clickedBtn.classList.add('incorrect');
      clickedBtn.classList.add('shake');
    } else {
      clickedBtn.classList.add('pop');
    }

    updateCardState(cardIdx, correct);
    showFeedback(correct, correctAnswer, cardIdx, false);
  }

  function handleWrittenAnswer(correct, correctAnswer, cardIdx) {
    state.session.answered = true;
    const input = $('#written-answer');
    input.disabled = true;

    if (correct) {
      input.style.borderColor = 'var(--success)';
    } else {
      input.style.borderColor = 'var(--error)';
    }

    updateCardState(cardIdx, correct);
    showFeedback(correct, correctAnswer, cardIdx, true);
  }

  function updateCardState(cardIdx, correct) {
    const cs = state.cardState[cardIdx];
    cs.lastSeen = Date.now();

    if (correct) {
      state.session.correctCount++;
      state.session.currentStreak++;
      if (state.session.currentStreak > state.session.bestStreak) {
        state.session.bestStreak = state.session.currentStreak;
      }

      cs.correctStreak++;

      if (cs.correctStreak >= MASTERY_STREAK) {
        cs.bucket = BUCKET.MASTERED;
        const interval = Math.pow(cs.easeFactor, cs.correctStreak - MASTERY_STREAK + 1) * 60000;
        cs.nextReview = Date.now() + interval;
        cs.easeFactor = Math.min(3.0, cs.easeFactor + 0.1);
      } else if (cs.correctStreak >= 1) {
        cs.bucket = BUCKET.REVIEWING;
        cs.nextReview = Date.now() + (cs.correctStreak * 30000);
      }

    } else {
      state.session.incorrectCount++;
      state.session.currentStreak = 0;

      cs.incorrectCount++;
      cs.correctStreak = Math.max(0, cs.correctStreak - 1);
      cs.bucket = BUCKET.LEARNING;
      cs.easeFactor = Math.max(1.3, cs.easeFactor - 0.2);
      cs.nextReview = 0;

      // Re-add to queue a few questions later so they see it again
      const reinsertAt = Math.min(
        state.session.queue.length,
        state.session.currentIndex + 3 + Math.floor(Math.random() * 3)
      );
      state.session.queue.splice(reinsertAt, 0, cardIdx);
      state.session.totalQuestions = state.session.queue.length;
    }

    updateProgress();
    saveSet();
  }

  function showFeedback(correct, correctAnswer, cardIdx, isWritten) {
    const feedback = $('#feedback');
    const card = state.cards[cardIdx];
    const overrideBtn = $('#btn-override');

    feedback.style.display = 'block';
    feedback.className = `feedback ${correct ? 'correct' : 'incorrect'}`;

    if (correct) {
      $('#feedback-icon').textContent = getRandomEmoji(true);
      $('#feedback-text').textContent = getRandomFeedback(true);
      $('#feedback-correct').textContent = '';
      overrideBtn.style.display = 'none';
    } else {
      $('#feedback-icon').textContent = getRandomEmoji(false);
      $('#feedback-text').textContent = getRandomFeedback(false);
      $('#feedback-correct').innerHTML = `Correct answer: <strong>${escapeHtml(correctAnswer)}</strong>`;
      // Show override button for written questions marked wrong
      overrideBtn.style.display = isWritten ? '' : 'none';
    }

    // Override: reverse the incorrect verdict
    overrideBtn.onclick = () => {
      // Undo the incorrect state update
      const cs = state.cardState[cardIdx];
      state.session.incorrectCount--;
      state.session.correctCount++;
      state.session.currentStreak++;
      if (state.session.currentStreak > state.session.bestStreak) {
        state.session.bestStreak = state.session.currentStreak;
      }

      cs.incorrectCount = Math.max(0, cs.incorrectCount - 1);
      cs.correctStreak += 2; // Restore the streak (+1 that was lost, +1 for this answer)
      cs.easeFactor = Math.min(3.0, cs.easeFactor + 0.2); // Undo the ease penalty

      if (cs.correctStreak >= MASTERY_STREAK) {
        cs.bucket = BUCKET.MASTERED;
        const interval = Math.pow(cs.easeFactor, cs.correctStreak - MASTERY_STREAK + 1) * 60000;
        cs.nextReview = Date.now() + interval;
      } else if (cs.correctStreak >= 1) {
        cs.bucket = BUCKET.REVIEWING;
        cs.nextReview = Date.now() + (cs.correctStreak * 30000);
      }

      // Remove the re-queued copy of this card from the session queue
      const qi = state.session.queue.indexOf(cardIdx, state.session.currentIndex + 1);
      if (qi !== -1) {
        state.session.queue.splice(qi, 1);
        state.session.totalQuestions = state.session.queue.length;
      }

      // Track as passed for phase transition
      if (state.session.phase === 'mcq' && state.session.mcqPassed) {
        state.session.mcqPassed.add(cardIdx);
      }

      updateProgress();
      saveSet();

      // Update UI to show correct
      feedback.className = 'feedback correct';
      $('#feedback-icon').textContent = getRandomEmoji(true);
      $('#feedback-text').textContent = 'Marked as correct!';
      $('#feedback-correct').textContent = '';
      overrideBtn.style.display = 'none';

      const writtenInput = $('#written-answer');
      writtenInput.style.borderColor = 'var(--success)';
    };

    // Speak feedback if audio on
    if (state.settings.audio && correct) {
      speak('Correct!');
    }

    const nextBtn = $('#btn-next');
    // Delay focus so a held Enter key from written submit doesn't immediately trigger next
    setTimeout(() => nextBtn.focus(), 300);
    nextBtn.onclick = () => {
      state.session.currentIndex++;
      const input = $('#written-answer');
      input.disabled = false;
      input.style.borderColor = '';
      showNextQuestion();
    };

    // Enter key to advance (but not when typing in an input)
    // Delay adding the handler so a held Enter from written submit doesn't skip feedback
    setTimeout(() => {
      const handler = (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          nextBtn.click();
          document.removeEventListener('keydown', handler);
        }
      };
      document.addEventListener('keydown', handler);
    }, 400);
  }

  // ===== RESULTS =====
  function showResults() {
    showScreen('results');

    const session = state.session;
    const total = session.correctCount + session.incorrectCount;
    const accuracy = total > 0 ? Math.round((session.correctCount / total) * 100) : 0;
    const mastered = state.cardState.filter(c => c.bucket >= BUCKET.MASTERED).length;
    const stillLearning = state.cards.length - mastered;

    // Title based on performance
    if (accuracy >= 90) {
      $('#results-icon').textContent = '\u{1F3C6}';
      $('#results-title').textContent = 'Outstanding!';
      $('#results-subtitle').textContent = 'You really know this material.';
    } else if (accuracy >= 70) {
      $('#results-icon').textContent = '\u{1F31F}';
      $('#results-title').textContent = 'Great Progress!';
      $('#results-subtitle').textContent = 'Keep it up and you\'ll master everything soon.';
    } else if (accuracy >= 50) {
      $('#results-icon').textContent = '\u{1F4AA}';
      $('#results-title').textContent = 'Getting There!';
      $('#results-subtitle').textContent = 'Practice makes perfect. Try another round!';
    } else {
      $('#results-icon').textContent = '\u{1F4DA}';
      $('#results-title').textContent = 'Keep Studying!';
      $('#results-subtitle').textContent = 'These terms need more review. You\'ll get them!';
    }

    $('#result-accuracy').textContent = `${accuracy}%`;
    $('#result-mastered').textContent = mastered;
    $('#result-reviewing').textContent = stillLearning;
    $('#result-streak').textContent = session.bestStreak;

    // Term breakdown
    const termsList = $('#results-terms-list');
    termsList.innerHTML = '';

    state.cardState.forEach((cs, i) => {
      const card = state.cards[i];
      let statusClass, statusLabel;

      if (cs.bucket >= BUCKET.MASTERED) {
        statusClass = 'mastered';
        statusLabel = 'Mastered';
      } else if (cs.bucket >= BUCKET.LEARNING) {
        statusClass = 'learning';
        statusLabel = `Streak: ${cs.correctStreak}/${MASTERY_STREAK}`;
      } else {
        statusClass = 'not-started';
        statusLabel = 'Not started';
      }

      termsList.innerHTML += `
        <div class="result-term-row">
          <div class="result-term-status ${statusClass}"></div>
          <div class="result-term-word">${escapeHtml(card.term)}</div>
          <div class="result-term-score">${statusLabel}</div>
        </div>
      `;
    });

    // Button handlers
    $('#btn-continue-learning').onclick = () => {
      startLearnSession();
    };

    $('#btn-restart').onclick = () => {
      state.cardState = initCardState(state.cards);
      saveSet();
      startLearnSession();
    };

    $('#btn-back-overview').onclick = () => {
      showOverview();
    };
  }

  // ===== DISTRACTOR GENERATION =====
  function generateDistractors(correctAnswer, cardIdx, count) {
    const distractors = [];

    // Pull distractors from the same side as the answer
    // If we're showing the term (showingTerm=true), the answer is a definition, so distractors are definitions
    // If we're showing the definition (showingTerm=false), the answer is a term, so distractors are terms
    const showingTerm = state.session.currentShowingTerm;
    const pool = state.cards
      .filter((_, i) => i !== cardIdx)
      .map(c => showingTerm ? c.definition : c.term);

    shuffleArray(pool);

    for (let i = 0; i < Math.min(count, pool.length); i++) {
      if (pool[i] !== correctAnswer) {
        distractors.push(pool[i]);
      }
    }

    // If not enough distractors, repeat with slight modifications
    while (distractors.length < count) {
      const base = pool[Math.floor(Math.random() * pool.length)] || correctAnswer;
      if (base !== correctAnswer && !distractors.includes(base)) {
        distractors.push(base);
      } else {
        break;
      }
    }

    return distractors.slice(0, count);
  }

  // ===== AUDIO (Text-to-Speech) =====
  function speak(text) {
    if (!state.audioEnabled) return;
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.9;
      utterance.pitch = 1;
      window.speechSynthesis.speak(utterance);
    }
  }

  // ===== THEME =====
  function setupTheme() {
    const saved = localStorage.getItem('studyforge_theme') || 'dark';
    if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');

    $('#btn-theme-toggle').addEventListener('click', () => {
      const isLight = document.documentElement.getAttribute('data-theme') === 'light';
      if (isLight) {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('studyforge_theme', 'dark');
      } else {
        document.documentElement.setAttribute('data-theme', 'light');
        localStorage.setItem('studyforge_theme', 'light');
      }
    });
  }

  function setupAudio() {
    const btn = $('#btn-audio-toggle');
    btn.addEventListener('click', () => {
      state.audioEnabled = !state.audioEnabled;
      btn.classList.toggle('active', state.audioEnabled);
    });
  }

  // ===== HELPERS =====
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  function getRandomFeedback(correct) {
    const positive = ['Correct!', 'Nice!', 'Well done!', 'Nailed it!', 'Exactly right!', 'You got it!', 'Perfect!'];
    const negative = ['Not quite.', 'Almost!', 'Keep trying!', 'Not this time.', 'Let\'s review that one.'];
    const arr = correct ? positive : negative;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function getRandomEmoji(correct) {
    const positive = ['\u2705', '\u{1F389}', '\u{1F31F}', '\u{1F4AF}', '\u{1F525}'];
    const negative = ['\u274C', '\u{1F914}', '\u{1F4AD}', '\u{1F504}'];
    const arr = correct ? positive : negative;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // ===== INIT =====
  function init() {
    setupTheme();
    setupAudio();
    setupImport();
    showScreen('import');

    // Logo click -> back to home
    $('#logo-home').onclick = () => {
      saveSet();
      showScreen('import');
      loadSavedSets();
    };
  }

  init();
})();
