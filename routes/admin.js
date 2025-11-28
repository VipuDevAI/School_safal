const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { parse } = require('csv-parse/sync');
const mammoth = require('mammoth');
const { pool, getConfig, setConfig } = require('../database');

function extractSheetId(url) {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

function extractGid(url) {
  const match = url.match(/gid=([0-9]+)/);
  return match ? match[1] : '0';
}

function parseGoogleDriveUrl(url) {
  if (!url) return '';
  url = url.trim();
  
  if (!url.match(/^https?:\/\/.*/)) return url;
  
  let id = '';
  let m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m && m[1]) id = m[1];
  if (url.indexOf('open?id=') !== -1) id = url.split('open?id=')[1].split('&')[0];
  if (url.indexOf('id=') !== -1 && !id) id = url.split('id=')[1].split('&')[0];
  
  if (id) return "https://drive.google.com/uc?export=view&id=" + id;
  return url;
}

function normalizeCorrectAnswer(val) {
  const s = String(val || '').trim().toUpperCase();
  if (!s) return '';
  if (['A', 'B', 'C', 'D'].includes(s)) return s;
  if (s.startsWith('OPTION A') || s === 'A)' || s.includes('(A)')) return 'A';
  if (s.startsWith('OPTION B') || s === 'B)' || s.includes('(B)')) return 'B';
  if (s.startsWith('OPTION C') || s === 'C)' || s.includes('(C)')) return 'C';
  if (s.startsWith('OPTION D') || s === 'D)' || s.includes('(D)')) return 'D';
  return s;
}
const { isAdminToken, getUserFromToken } = require('./auth');

async function requireAdmin(req, res, next) {
  const token = req.body.token || req.query.token;
  const isAdmin = await isAdminToken(token);
  
  if (!isAdmin) {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }
  
  next();
}

router.post('/create-user', requireAdmin, async (req, res) => {
  try {
    const { username, password, displayName, isAdmin } = req.body;
    const normalizedUsername = (username || '').toLowerCase().trim();

    if (!normalizedUsername) {
      return res.json({ success: false, message: 'Username required' });
    }

    const existingUser = await pool.query(
      'SELECT * FROM users WHERE LOWER(username) = $1',
      [normalizedUsername]
    );

    if (existingUser.rows.length > 0) {
      return res.json({ success: false, message: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    
    await pool.query(
      `INSERT INTO users (username, password, display_name, is_admin) 
       VALUES ($1, $2, $3, $4)`,
      [normalizedUsername, hashedPassword, displayName || normalizedUsername, isAdmin || false]
    );

    if (isAdmin) {
      const existing = await getConfig('AdminUsers') || '';
      const list = existing ? existing.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];
      if (!list.includes(normalizedUsername)) {
        list.push(normalizedUsername);
        await setConfig('AdminUsers', list.join(','));
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Create user error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/bulk-create-users', requireAdmin, async (req, res) => {
  try {
    const { csvText, passwordPrefix } = req.body;
    const results = [];

    let rows;
    try {
      rows = parse(csvText, { skip_empty_lines: true, relax_column_count: true });
    } catch (e) {
      rows = csvText.split('\n').map(line => line.split(','));
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row[0]) continue;

      const username = (row[0] || '').trim().toLowerCase();
      const displayName = row[1] ? row[1].trim() : username;
      const password = row[2] ? row[2].trim() : (passwordPrefix || 'safal') + (i + 1);

      try {
        const existing = await pool.query(
          'SELECT * FROM users WHERE LOWER(username) = $1',
          [username]
        );

        if (existing.rows.length > 0) {
          results.push([username, 'ERROR: User already exists']);
          continue;
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query(
          `INSERT INTO users (username, password, display_name, is_admin) 
           VALUES ($1, $2, $3, FALSE)`,
          [username, hashedPassword, displayName]
        );

        results.push([username, 'OK']);
      } catch (e) {
        results.push([username, 'ERROR: ' + e.message]);
      }
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('Bulk create users error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/upload-questions', requireAdmin, async (req, res) => {
  try {
    const { csvText } = req.body;
    let added = 0;

    let rows;
    try {
      rows = parse(csvText, { skip_empty_lines: true, relax_column_count: true });
    } catch (e) {
      rows = csvText.split('\n').map(line => line.split(','));
    }

    for (const row of rows) {
      if (!row[0]) continue;

      const subject = (row[0] || '').trim();
      const questionText = (row[1] || '').trim();
      const optionA = (row[2] || '').trim();
      const optionB = (row[3] || '').trim();
      const optionC = (row[4] || '').trim();
      const optionD = (row[5] || '').trim();
      const correct = (row[6] || '').trim();
      const imageUrl = (row[7] || '').trim();

      if (!questionText) continue;

      await pool.query(
        `INSERT INTO questions (subject, question_text, option_a, option_b, option_c, option_d, correct_answer, image_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [subject, questionText, optionA, optionB, optionC, optionD, correct, imageUrl]
      );

      added++;
    }

    res.json({ success: true, added });
  } catch (error) {
    console.error('Upload questions error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/upload-word-questions', requireAdmin, async (req, res) => {
  try {
    const { wordBase64, subject, filename } = req.body;
    
    if (!wordBase64 || !subject) {
      return res.json({ success: false, message: 'Word file and subject required' });
    }

    const buffer = Buffer.from(wordBase64, 'base64');
    const result = await mammoth.convertToHtml({ buffer }, {
      convertImage: mammoth.images.imgElement(function(image) {
        return image.read("base64").then(function(imageBuffer) {
          return { src: "data:" + image.contentType + ";base64," + imageBuffer };
        });
      })
    });
    
    const html = result.value;
    let added = 0;
    let passageCount = 0;

    // Split by paragraphs and clean - keep HTML for images
    const rawBlocks = html.split(/<p[^>]*>/).map(b => b.replace(/<\/p>/g, '').trim()).filter(b => b);
    
    // Build array of content items with text and images
    let contentItems = [];
    let currentPassage = null;
    let currentPassageId = null;
    
    for (let i = 0; i < rawBlocks.length; i++) {
      const block = rawBlocks[i];
      const plainText = block.replace(/<[^>]+>/g, '').trim();
      const imgMatch = block.match(/<img[^>]+src="([^"]+)"[^>]*>/i);
      
      // Skip empty blocks (but keep image-only blocks)
      if (!plainText && !imgMatch) continue;
      
      // Check for passage headers
      const isPassageHeader = plainText.toLowerCase().includes('read the passage') ||
                             plainText.toLowerCase().includes('read the following') ||
                             plainText.toLowerCase().includes('read the poem');
      
      if (isPassageHeader) {
        passageCount++;
        currentPassageId = passageCount;
        currentPassage = '';
        continue;
      }
      
      // Check if this is passage content (long text, not an answer line)
      if (currentPassage !== null && plainText.length > 150 && !plainText.match(/^Answer\s*:/i)) {
        currentPassage += (currentPassage ? ' ' : '') + plainText;
        continue;
      }
      
      contentItems.push({
        text: plainText,
        html: block,
        image: imgMatch ? imgMatch[1] : null,
        passageText: currentPassage,
        passageId: currentPassageId
      });
    }
    
    // Now find questions by looking for "Answer: X" pattern
    // Work backwards from each Answer line to find question + 4 options
    for (let i = 0; i < contentItems.length; i++) {
      const item = contentItems[i];
      const answerMatch = item.text.match(/^Answer\s*:\s*([A-D])/i);
      
      if (answerMatch) {
        const correctAnswer = answerMatch[1].toUpperCase();
        
        // Look backwards to find 4 options and 1 question (minimum 5 items before Answer)
        // But options might have images on separate lines, so be flexible
        let optionItems = [];
        let questionItems = [];
        let j = i - 1;
        
        // Collect items backwards until we have enough for options
        while (j >= 0 && optionItems.length < 4) {
          const prevItem = contentItems[j];
          // Skip section headers and empty-ish items
          if (prevItem.text.toLowerCase().includes('multiple choice') ||
              prevItem.text.toLowerCase().includes('answer key') ||
              prevItem.text.toLowerCase().includes('question paper') ||
              prevItem.text.toLowerCase().includes('marks:') ||
              prevItem.text.match(/^[IVX]+\.\s/) ||
              prevItem.text.match(/^Answer\s*:/i)) {
            j--;
            continue;
          }
          optionItems.unshift(prevItem);
          j--;
        }
        
        // If we have at least 4 items, last 4 are options, rest is question
        if (optionItems.length >= 5) {
          questionItems = optionItems.slice(0, optionItems.length - 4);
          optionItems = optionItems.slice(-4);
        } else if (optionItems.length >= 4) {
          // Exactly 4 items - need to look further back for question
          while (j >= 0 && questionItems.length === 0) {
            const prevItem = contentItems[j];
            if (prevItem.text && 
                !prevItem.text.toLowerCase().includes('multiple choice') &&
                !prevItem.text.toLowerCase().includes('answer key') &&
                !prevItem.text.match(/^Answer\s*:/i) &&
                prevItem.text.length > 10) {
              questionItems.unshift(prevItem);
              break;
            }
            j--;
          }
        }
        
        if (questionItems.length > 0 && optionItems.length >= 4) {
          // Build question text
          let questionText = questionItems.map(q => q.text).join(' ').trim();
          let questionImage = questionItems.find(q => q.image)?.image || '';
          
          // Get options
          const optionA = optionItems[0].text.replace(/^[aA][\.\)]\s*/, '').trim();
          const optionB = optionItems[1].text.replace(/^[bB][\.\)]\s*/, '').trim();
          const optionC = optionItems[2].text.replace(/^[cC][\.\)]\s*/, '').trim();
          const optionD = optionItems[3].text.replace(/^[dD][\.\)]\s*/, '').trim();
          
          // Get option images
          const optionAImg = optionItems[0].image || '';
          const optionBImg = optionItems[1].image || '';
          const optionCImg = optionItems[2].image || '';
          const optionDImg = optionItems[3].image || '';
          
          // Use first available image
          const imageUrl = questionImage || optionAImg || optionBImg || optionCImg || optionDImg;
          
          // Get passage info from the answer item
          const passageText = item.passageText || null;
          const passageId = item.passageId || null;
          
          if (questionText && (optionA || optionB)) {
            await pool.query(
              `INSERT INTO questions (subject, question_text, option_a, option_b, option_c, option_d, correct_answer, image_url, passage_id, passage_text)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [subject, questionText, optionA || '[Image]', optionB || '[Image]', optionC || '[Image]', optionD || '[Image]', correctAnswer, imageUrl, passageId, passageText]
            );
            added++;
          }
        }
      }
    }

    if (added > 0) {
      const docName = filename || 'Word Document';
      const uploadResult = await pool.query(
        `INSERT INTO uploads (filename, subject, source, question_count) VALUES ($1, $2, $3, $4) RETURNING id`,
        [docName, subject, 'word', added]
      );
      const uploadId = uploadResult.rows[0].id;
      await pool.query(
        `UPDATE questions SET upload_id = $1 WHERE upload_id IS NULL AND subject = $2`,
        [uploadId, subject]
      );
    }

    res.json({ success: true, added, passages: passageCount });
  } catch (error) {
    console.error('Upload Word questions error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/import-google-sheet', requireAdmin, async (req, res) => {
  try {
    const { sheetUrl } = req.body;
    
    if (!sheetUrl) {
      return res.json({ success: false, message: 'Sheet URL required' });
    }

    const sheetId = extractSheetId(sheetUrl);
    if (!sheetId) {
      return res.json({ success: false, message: 'Invalid Google Sheet URL. Please use a valid Google Sheets link.' });
    }

    const gid = extractGid(sheetUrl);
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;

    const response = await fetch(csvUrl);
    if (!response.ok) {
      return res.json({ 
        success: false, 
        message: 'Could not fetch sheet. Make sure the sheet is published to web or shared as "Anyone with the link".' 
      });
    }

    const csvText = await response.text();
    let added = 0;
    let skipped = 0;

    let rows;
    try {
      rows = parse(csvText, { skip_empty_lines: true, relax_column_count: true });
    } catch (e) {
      rows = csvText.split('\n').map(line => line.split(','));
    }

    const header = rows[0] || [];
    const headerLower = header.map(h => (h || '').toString().toLowerCase());
    
    let isGoogleFormFormat = headerLower.some(h => h.includes('timestamp'));
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      
      if (i === 0 && (headerLower.includes('timestamp') || headerLower.some(h => h.includes('subject')))) {
        continue;
      }

      if (!row[0] && !row[1]) continue;

      let subject, questionText, optionA, optionB, optionC, optionD, correct, imageUrl;

      if (isGoogleFormFormat) {
        subject = (row[1] || '').trim();
        questionText = (row[2] || '').trim();
        imageUrl = parseGoogleDriveUrl(row[3] || '');
        optionA = (row[4] || '').trim().replace(/^[A-D]\)\s*/i, '');
        optionB = (row[5] || '').trim().replace(/^[A-D]\)\s*/i, '');
        optionC = (row[6] || '').trim().replace(/^[A-D]\)\s*/i, '');
        optionD = (row[7] || '').trim().replace(/^[A-D]\)\s*/i, '');
        correct = normalizeCorrectAnswer(row[8] || '');
      } else {
        subject = (row[0] || '').trim();
        questionText = (row[1] || '').trim();
        optionA = (row[2] || '').trim();
        optionB = (row[3] || '').trim();
        optionC = (row[4] || '').trim();
        optionD = (row[5] || '').trim();
        correct = normalizeCorrectAnswer(row[6] || '');
        imageUrl = parseGoogleDriveUrl(row[7] || '');
      }

      if (!questionText) {
        skipped++;
        continue;
      }

      await pool.query(
        `INSERT INTO questions (subject, question_text, option_a, option_b, option_c, option_d, correct_answer, image_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [subject, questionText, optionA, optionB, optionC, optionD, correct, imageUrl]
      );

      added++;
    }

    if (added > 0) {
      const uploadResult = await pool.query(
        `INSERT INTO uploads (filename, subject, source, question_count) VALUES ($1, $2, $3, $4) RETURNING id`,
        ['Google Sheet', 'Mixed', 'sheet', added]
      );
      const uploadId = uploadResult.rows[0].id;
      await pool.query(
        `UPDATE questions SET upload_id = $1 WHERE upload_id IS NULL`,
        [uploadId]
      );
    }

    res.json({ success: true, added, skipped });
  } catch (error) {
    console.error('Import Google Sheet error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/set-exam-active', requireAdmin, async (req, res) => {
  try {
    const { active } = req.body;
    await setConfig('ExamActive', active ? 'TRUE' : 'FALSE');
    res.json({ success: true });
  } catch (error) {
    console.error('Set exam active error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/set-total-questions', requireAdmin, async (req, res) => {
  try {
    const { total } = req.body;
    const num = parseInt(total, 10);
    
    if (!num || num < 1) {
      return res.json({ success: false, message: 'Invalid number' });
    }

    await setConfig('TotalQuestionsPerSubject', String(num));
    res.json({ success: true });
  } catch (error) {
    console.error('Set total questions error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/set-active-subject', requireAdmin, async (req, res) => {
  try {
    const { subject } = req.body;
    const subjectName = (subject || '').trim();

    if (!subjectName) {
      return res.json({ success: false, message: 'Subject required' });
    }

    await setConfig('ActiveSubject', subjectName);
    res.json({ success: true, activeSubject: subjectName });
  } catch (error) {
    console.error('Set active subject error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/get-summary', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT submitted_at as timestamp, username, subject, score FROM responses ORDER BY submitted_at DESC'
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Get summary error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/export-csv', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM responses ORDER BY submitted_at DESC'
    );

    const headers = ['Timestamp', 'Username', 'Subject', 'Score', 'Answers'];
    const rows = result.rows.map(row => [
      row.submitted_at,
      row.username,
      row.subject,
      row.score,
      JSON.stringify(row.answers)
    ]);

    const csv = [headers, ...rows]
      .map(row => row.map(cell => {
        if (cell === null || cell === undefined) return '""';
        const s = String(cell).replace(/"/g, '""');
        return `"${s}"`;
      }).join(','))
      .join('\n');

    res.json({ success: true, csv });
  } catch (error) {
    console.error('Export CSV error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/get-config', async (req, res) => {
  try {
    const { token, key } = req.body;
    
    const user = await getUserFromToken(token);
    if (!user) {
      return res.json({ error: 'Invalid session token' });
    }

    const value = await getConfig(key);
    res.json({ value });
  } catch (error) {
    console.error('Get config error:', error);
    res.json({ error: error.message });
  }
});

router.post('/get-users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ success: true, users: result.rows });
  } catch (error) {
    console.error('Get users error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/delete-user', requireAdmin, async (req, res) => {
  try {
    const { userId, username } = req.body;
    
    const userResult = await pool.query(
      'SELECT * FROM users WHERE id = $1 OR LOWER(username) = $2',
      [userId || 0, (username || '').toLowerCase()]
    );
    
    if (userResult.rows.length === 0) {
      return res.json({ success: false, message: 'User not found' });
    }
    
    const user = userResult.rows[0];
    if (user.is_admin) {
      return res.json({ success: false, message: 'Cannot delete admin users' });
    }
    
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    await pool.query('DELETE FROM responses WHERE LOWER(username) = $1', [user.username.toLowerCase()]);
    await pool.query('DELETE FROM grades WHERE LOWER(username) = $1', [user.username.toLowerCase()]);
    
    res.json({ success: true, deleted: user.username });
  } catch (error) {
    console.error('Delete user error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/delete-all-students', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM users WHERE is_admin = FALSE RETURNING username');
    const deleted = result.rows.length;
    
    if (deleted > 0) {
      await pool.query('DELETE FROM responses');
      await pool.query('DELETE FROM grades');
    }
    
    res.json({ success: true, deleted });
  } catch (error) {
    console.error('Delete all students error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/get-uploads', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, filename, subject, source, question_count, uploaded_at FROM uploads ORDER BY uploaded_at DESC'
    );
    res.json({ success: true, uploads: result.rows });
  } catch (error) {
    console.error('Get uploads error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/delete-upload', requireAdmin, async (req, res) => {
  try {
    const { uploadId } = req.body;
    
    if (!uploadId) {
      return res.json({ success: false, message: 'Upload ID required' });
    }
    
    const uploadResult = await pool.query('SELECT * FROM uploads WHERE id = $1', [uploadId]);
    if (uploadResult.rows.length === 0) {
      return res.json({ success: false, message: 'Upload not found' });
    }
    
    const upload = uploadResult.rows[0];
    
    await pool.query('DELETE FROM questions WHERE upload_id = $1', [uploadId]);
    await pool.query('DELETE FROM uploads WHERE id = $1', [uploadId]);
    
    res.json({ 
      success: true, 
      message: `Deleted "${upload.filename}" (${upload.question_count} questions)` 
    });
  } catch (error) {
    console.error('Delete upload error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/get-question-count', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT subject, COUNT(*) as count FROM questions GROUP BY subject ORDER BY subject'
    );
    
    const passageResult = await pool.query('SELECT COUNT(*) as count FROM passages');
    
    res.json({ 
      success: true, 
      counts: result.rows,
      passageCount: parseInt(passageResult.rows[0].count) || 0
    });
  } catch (error) {
    console.error('Get question count error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/clear-questions', requireAdmin, async (req, res) => {
  try {
    const { subject } = req.body;
    
    if (subject && subject !== 'all') {
      await pool.query('DELETE FROM questions WHERE subject = $1', [subject]);
      await pool.query('DELETE FROM uploads WHERE subject = $1', [subject]);
      res.json({ success: true, message: `Cleared all ${subject} questions` });
    } else {
      await pool.query('DELETE FROM questions');
      await pool.query('DELETE FROM passages');
      await pool.query('DELETE FROM uploads');
      res.json({ success: true, message: 'Cleared all questions and passages' });
    }
  } catch (error) {
    console.error('Clear questions error:', error);
    res.json({ success: false, message: error.message });
  }
});

router.post('/get-result-details', requireAdmin, async (req, res) => {
  try {
    const { username, subject } = req.body;
    
    const userResult = await pool.query(
      'SELECT assigned_questions FROM users WHERE LOWER(username) = $1',
      [username.toLowerCase()]
    );
    
    const responseResult = await pool.query(
      'SELECT * FROM responses WHERE LOWER(username) = $1 AND subject = $2 ORDER BY submitted_at DESC LIMIT 1',
      [username.toLowerCase(), subject]
    );
    
    if (responseResult.rows.length === 0) {
      return res.json({ success: false, message: 'Response not found' });
    }
    
    const response = responseResult.rows[0];
    const studentAnswers = typeof response.answers === 'string' 
      ? JSON.parse(response.answers) 
      : (response.answers || {});
    
    let questionIds = [];
    if (userResult.rows.length > 0 && userResult.rows[0].assigned_questions) {
      const assignedObj = typeof userResult.rows[0].assigned_questions === 'string'
        ? JSON.parse(userResult.rows[0].assigned_questions)
        : userResult.rows[0].assigned_questions;
      if (assignedObj[subject] && Array.isArray(assignedObj[subject])) {
        questionIds = assignedObj[subject];
      }
    }
    
    if (questionIds.length === 0) {
      questionIds = Object.keys(studentAnswers).map(id => parseInt(id)).filter(id => !isNaN(id));
    }
    
    if (questionIds.length === 0) {
      return res.json({ success: true, details: [], score: response.score });
    }
    
    const questionsResult = await pool.query(
      `SELECT q.*, p.passage_text 
       FROM questions q 
       LEFT JOIN passages p ON q.passage_id = p.id 
       WHERE q.id = ANY($1)`,
      [questionIds]
    );
    
    const questionMap = {};
    questionsResult.rows.forEach(q => {
      questionMap[q.id] = q;
    });
    
    const details = questionIds.map((qid, idx) => {
      const q = questionMap[qid];
      if (!q) return null;
      
      const studentAnswer = (studentAnswers[qid] || '').toUpperCase();
      const correctAnswer = (q.correct_answer || '').toUpperCase().trim();
      let correctLetter = correctAnswer;
      if (correctAnswer.startsWith('OPTION A')) correctLetter = 'A';
      else if (correctAnswer.startsWith('OPTION B')) correctLetter = 'B';
      else if (correctAnswer.startsWith('OPTION C')) correctLetter = 'C';
      else if (correctAnswer.startsWith('OPTION D')) correctLetter = 'D';
      
      return {
        qNo: idx + 1,
        question: q.question_text,
        passage: q.passage_text || null,
        optionA: q.option_a,
        optionB: q.option_b,
        optionC: q.option_c,
        optionD: q.option_d,
        correctAnswer: correctLetter,
        studentAnswer: studentAnswer,
        isCorrect: studentAnswer && studentAnswer === correctLetter
      };
    }).filter(d => d !== null);
    
    res.json({ 
      success: true, 
      details, 
      score: response.score,
      total: details.length
    });
  } catch (error) {
    console.error('Get result details error:', error);
    res.json({ success: false, message: error.message });
  }
});

module.exports = router;
